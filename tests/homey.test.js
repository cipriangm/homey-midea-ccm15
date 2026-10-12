'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const Module=require('node:module');const originalLoad=Module._load;
class Base {
  constructor(){this.values={};this.store={};this.listeners={};this.settings={host:'192.168.50.10',port:80,enable_control:false,extras_policy:'blocked',start_mode:'cool'};}
  getSettings(){return this.settings;}getSetting(k){return this.settings[k];}getData(){return {id:'stable:a0',slot:0};}
  async setSettings(values){Object.assign(this.settings,values);}
  getCapabilityValue(k){return this.values[k]??null;}async setCapabilityValue(k,v){this.values[k]=v;}
  getCapabilityOptions(k){return this.capOptions?.[k] || require('../app.json').drivers[0].capabilitiesOptions[k] || {};}
  async setCapabilityOptions(k,options){this.capOptions ??= {};this.capOptions[k]=options;}
  getStoreValue(k){return this.store[k];}async setStoreValue(k,v){this.store[k]=v;}
  registerCapabilityListener(k,fn){this.listeners[k]=fn;}
  hasCapability(k){return !this.removed?.has(k);}
  async addCapability(k){this.removed?.delete(k);}
  async removeCapability(k){if(!this.removed)this.removed=new Set();this.removed.add(k);}
  async setUnavailable(reason){this.available=false;this.unavailableReason=reason;}async setAvailable(){this.available=true;}
  async setWarning(reason){this.warning=reason;}async unsetWarning(){this.warning=null;}
  error(){}
}
Module._load=function(name,...args){return name==='homey'?{App:Base,Device:Base,Driver:Base}:originalLoad.call(this,name,...args);};
const App=require('../app');const Device=require('../drivers/indoor/device');const Driver=require('../drivers/indoor/driver');
Module._load=originalLoad;
const {decode}=require('../lib/protocol');const {Gateway}=require('../lib/gateway');
const fixture=require('node:fs').readFileSync(`${__dirname}/fixtures/live-status.xml`,'utf8');
const {FakeClock}=require('./helpers/fake-clock');
function environment(){
 const actions={},conditions={},triggers=[],saved=new Map();
 const clock=new FakeClock();
 const homey={setInterval:()=>1,clearInterval:()=>{},setTimeout:(fn,ms)=>clock.setTimeout(fn,ms),clearTimeout:id=>clock.clearTimeout(id),settings:{get:key=>saved.get(key),set:(key,value)=>saved.set(key,value)},flow:{getActionCard:id=>({registerRunListener:fn=>{actions[id]=fn;}}),getConditionCard:id=>({registerRunListener:fn=>{conditions[id]=fn;}}),getDeviceTriggerCard:id=>({trigger:async(device,tokens)=>{triggers.push({id,tokens});}})}};
 const app=new App();app.readGatewayMetadata=async()=>({gateway:null,rooms:null});homey.app=app;app.homey=homey;return {app,homey,actions,conditions,triggers,clock};
}
async function drainUi(d){await Promise.all([...d.uiChanges.running].map(draft=>draft.task));}
test('App registers all manifest actions and conditions including target temperature',async()=>{
 const {app,actions,conditions}=environment();await app.onInit();
 const manifest=require('../app.json');assert.deepEqual(Object.keys(actions).sort(),manifest.flow.actions.map(c=>c.id).sort());
 assert.deepEqual(Object.keys(conditions).sort(),manifest.flow.conditions.map(c=>c.id).sort());
 let patch;await actions.set_temperature({device:{change:async p=>{patch=p;}},temperature:23});assert.deepEqual(patch,{target:23});
 await actions.set_climate({device:{change:async p=>{patch=p;}},temperature:24,mode:'heat',fan:'low'});assert.deepEqual(patch,{mode:'heat',fan:'low',target:24});
});
test('Malformed Flow values cannot become an unintended Off or unlock another restriction',async()=>{
 const {app,actions,conditions}=environment();await app.onInit();let calls=0;
 const device={setPower:async()=>{calls++;},change:async()=>{calls++;},setLock:async()=>{calls++;}};
 for(const [id,args] of [['set_power',{power:'invalid'}],['set_swing',{state:undefined}],['set_heater',{state:false}],['set_remote_lock',{state:'locked'}],['clear_temperature_limit',{kind:'mode'}]]) {
   assert.throws(()=>actions[id]({device,...args}),/Choose/);
 }
 assert.equal(calls,0);
 const d=new Device();d.values={ccm15_connected:true,measure_temperature:null,ccm15_error:null};
 assert.equal(await conditions.has_fault({device:d}),false);
 assert.equal(await conditions.temperature_above({device:d,temperature:-1}),false);
});
test('Lock Flow cards route values, clearing limits does not change climate, and conditions require a fresh slot',async()=>{
 const {app,actions,conditions}=environment();await app.onInit();const calls=[];
 const d={setLock:async(kind,value)=>calls.push([kind,value])};
 await actions.set_mode_lock({device:d,value:'cool'});await actions.set_fan_lock({device:d,value:'unlocked'});
 await actions.set_cooling_limit({device:d,temperature:21});await actions.set_heating_limit({device:d,temperature:27});
 await actions.clear_temperature_limit({device:d,kind:'coolLimit'});await actions.set_remote_lock({device:d,state:'on'});
 assert.deepEqual(calls,[['mode','cool'],['fan','unlocked'],['coolLimit',21],['heatLimit',27],['coolLimit',null],['remote',true]]);
 const indoor=new Device();indoor.values={ccm15_connected:true,ccm15_cool_limit:21,ccm15_heat_limit:null,ccm15_remote_locked:true};
 assert.equal(await conditions.is_locked({device:indoor,kind:'coolLimit'}),true);
 assert.equal(await conditions.is_locked({device:indoor,kind:'heatLimit'}),false);
 indoor.values.ccm15_connected=false;assert.equal(await conditions.is_locked({device:indoor,kind:'remote'}),false);
});
test('Command result is shown, stored locally in a bounded history and exposed as a Flow trigger',async()=>{
 const {app,homey,triggers}=environment();await app.onInit();const d=new Device();d.homey=homey;d.gatewayKey='192.168.50.10:80';
 await app.recordCommand(d,{status:'pending',slot:0,kind:'climate',observations:[],durationMs:0});
 assert.equal(d.values.ccm15_command_status,'pending');assert.equal(homey.settings.get('command_diagnostics'),undefined);
 for(let i=0;i<23;i++)await app.recordCommand(d,{status:'confirmed',slot:0,kind:'climate',observations:[{actual:{target:23}}],durationMs:1200,sequence:i});
 assert.equal(d.values.ccm15_command_status,'confirmed');assert.match(d.values.ccm15_command_detail,/confirmed after 1/);
 const records=homey.settings.get('command_diagnostics');assert.equal(records.length,20);assert.equal(records[0].sequence,3);
 assert.ok(triggers.some(t=>t.id==='command_result'&&t.tokens.seconds===1.2));
 await app.recordCommand(d,{status:'unconfirmed',slot:0,kind:'climate',observations:[],durationMs:15000,detail:'target: expected 23, reported 26'});
 assert.equal(d.values.ccm15_command_status,'unconfirmed');assert.equal(d.values.ccm15_command_detail,'target: expected 23, reported 26');
});
test('Lock capability listeners convert temperature enums and preserve central control options',async()=>{
 const {app,homey,clock}=environment();await app.onInit();const d=new Device();d.homey=homey;
 d.refresh=async()=>{};d.settings={...d.settings,enable_control:true,extras_policy:'preserve',indoor_type:'ducted'};
 await d.onInit();const calls=[];d.client.setLock=async(slot,kind,value,options)=>{calls.push({slot,kind,value,options});return new Map();};
 await d.listeners.ccm15_cooling_limit_control('21');await d.listeners.ccm15_heating_limit_control('unlocked');await d.listeners.ccm15_remote_lock_control(true);
 assert.equal(calls.length,0);await clock.advance(1000);await drainUi(d);
 assert.deepEqual(calls.map(({kind,value})=>[kind,value]),[['coolLimit',21],['heatLimit',null],['remote',true]]);
 assert.ok(calls.every(c=>c.options.controlEnabled===true&&typeof c.options.onDiagnostic==='function'));
});
test('Shared gateway and coalesced polling for nine devices',async()=>{
 const {app,homey}=environment();await app.onInit();const devices=[];
 for(let i=0;i<9;i++){const d=new Device();d.homey=homey;devices.push(d);const client=app.attach(d);assert.equal(client,app.attach(devices[0]));}
 assert.equal(app.gateways.size,1);
 let reads=0;const client=app.attach(devices[0]);client.transport=async()=>{reads++;return fixture;};
 await Promise.all(Array.from({length:9},()=>client.poll()));assert.equal(reads,1);
 for(const d of devices)app.detach(d);assert.equal(app.gateways.size,0);
});
test('Device updates sensors, faults and locks; missing state becomes unavailable',async()=>{
 const {homey,triggers}=environment();const d=new Device();d.homey=homey;
 await d.updateState(decode('00000010d0001a',0));assert.equal(d.available,true);assert.equal(d.values.target_temperature,26);
 assert.equal(d.values.ccm15_connected,true);assert.equal(d.values.ccm15_swing,false);
 await d.updateState(decode('00000410d0001b',0));assert.equal(d.values.alarm_generic,true);assert.equal(d.values.ccm15_error,1);
 assert.ok(triggers.some(t=>t.id==='state_changed'&&t.tokens.temperature===27));
 await d.updateState(null,new Error('timeout'));assert.equal(d.available,false);assert.equal(d.values.ccm15_connected,false);
 assert.equal(d.values.measure_temperature,27); // retained but explicitly unavailable
});
test('Inactive restrictions display explicit states while retaining null numeric Flow values and raw codes',async()=>{
 const {homey}=environment();const d=new Device();d.homey=homey;
 // Stored heat threshold and reserved mode/fan codes do not activate a lock.
 await d.updateState(decode(Buffer.from([20<<3,(7<<5)|29,3,0x10,24<<3,0,25]).toString('hex'),0));
 assert.equal(d.values.ccm15_cooling_limit_status,'No limit');assert.equal(d.values.ccm15_heating_limit_status,'No limit');
 assert.equal(d.values.ccm15_mode_restriction_status,'Unlocked');assert.equal(d.values.ccm15_fan_restriction_status,'Unlocked');
 assert.equal(d.getCapabilityValue('ccm15_cool_limit'),null);assert.equal(d.getCapabilityValue('ccm15_heat_limit'),null);
 assert.equal(d.values.ccm15_locked_mode,'3');assert.equal(d.values.ccm15_locked_fan,'7');
 assert.ok(Object.values(d.capOptions).every(o=>o.values.every(v=>v.id!=='unknown')));
 await d.updateState(null);assert.equal(d.values.ccm15_connected,false);assert.equal(d.values.ccm15_heating_limit_status,'No limit');
});
test('Active unusual restrictions retain their exact reported values and diagnostic choices',async()=>{
 const {homey}=environment();const d=new Device();d.homey=homey;
 await d.updateState(decode(Buffer.from([0,(7<<5)|31,3,0x12,24<<3,8|16|32,25]).toString('hex'),0));
 assert.equal(d.values.ccm15_cooling_limit_status,'0°C');assert.equal(d.values.ccm15_heating_limit_status,'31°C');
 assert.equal(d.values.ccm15_cool_limit,0);assert.equal(d.values.ccm15_heat_limit,31);
 assert.equal(d.values.ccm15_mode_restriction_status,'Unrecognized code 3');
 assert.equal(d.values.ccm15_fan_restriction_status,'Unrecognized code 7');
 for(const cap of ['ccm15_cooling_limit_control','ccm15_heating_limit_control','ccm15_mode_restriction','ccm15_fan_restriction']) assert.ok(d.capOptions[cap].values.some(v=>v.id==='unknown'));
 await assert.rejects(d.setLock('heatLimit',31),/17 to 30/);
});
test('Picker choices reflect the configured VRF circuit without disturbing a selection or dropping Operating mode title',async()=>{
 const {homey}=environment();const d=new Device();d.homey=homey;d.settings.vrf_policy='heat_pump';
 const state=decode('00000010d0001a',0);await d.updateState(state);
 assert.equal(d.capOptions.thermostat_mode.title.en,'Operating mode');
 assert.ok(!d.capOptions.thermostat_mode.values.some(v=>['auto','unknown'].includes(v.id)));
 const original=d.capOptions.thermostat_mode;d.uiChanges={isHolding:()=>true};
 await d.updateState(decode('00000015d0001a',0));assert.equal(d.capOptions.thermostat_mode,original);
 d.uiChanges={isHolding:()=>false};await d.updateState(d.reportedState);
 assert.ok(d.capOptions.thermostat_mode.values.some(v=>v.id==='auto')); // Actual Auto is not hidden.
});
test('Fan Off remains a real reported state but is not offered on a running indoor',async()=>{
 const {homey}=environment();const d=new Device();d.homey=homey;
 await d.updateState(decode('00000010d0001a',0));assert.ok(d.capOptions.ccm15_fan.values.some(v=>v.id==='off'));
 await d.updateState(decode('00000001d0001a',0));assert.ok(!d.capOptions.ccm15_fan.values.some(v=>v.id==='off'));
 await d.updateState(decode('000000a1d0001a',0));assert.equal(d.values.ccm15_fan,'off');assert.ok(d.capOptions.ccm15_fan.values.some(v=>v.id==='off'));
});
test('Power restores last observed active mode; first start uses configured mode',async()=>{
 const d=new Device();let patch;d.change=async fn=>{patch=fn(decode('00000010d0001a',0));};
 d.settings.start_mode='heat';await d.setPower(true);assert.deepEqual(patch,{mode:'heat'});
 d.store.last_active_mode='dry';await d.setPower(true);assert.deepEqual(patch,{mode:'dry'});
 await d.setPower(false);assert.deepEqual(patch,{mode:'off'});
});
test('Connection and temperature conditions refuse stale values',async()=>{
 const {app,conditions}=environment();await app.onInit();const d=new Device();d.values={ccm15_connected:false,measure_temperature:29,ccm15_mode:'heat',ccm15_error:5};
 assert.equal(await conditions.temperature_above({device:d,temperature:25}),false);
 assert.equal(await conditions.is_mode({device:d,value:'heat'}),false);
 assert.equal(await conditions.has_fault({device:d}),false);
 d.values.ccm15_connected=true;assert.equal(await conditions.temperature_above({device:d,temperature:25}),true);
});
test('Pairing reads only and returns stable individual devices with control disabled',async()=>{
 const poll=Gateway.prototype.poll;Gateway.prototype.poll=async function(){return require('../lib/protocol').parseStatus(fixture);};
 try{
  const handlers={},driver=new Driver();driver.metadataFor=async()=>({gateway:null,rooms:null});await driver.onPair({setHandler:(id,fn)=>{handlers[id]=fn;}});
  await assert.rejects(handlers.list_devices(),/Configure/);
  assert.equal(await handlers.configure({host:'192.168.50.10',port:80,gatewayId:'ccm15-testsite'}),9);
  const paired=await handlers.list_devices();assert.equal(paired.length,9);assert.equal(paired[8].data.id,'ccm15-testsite:a8');
  assert.ok(paired.every(p=>p.settings.enable_control===false && p.settings.extras_policy==='blocked'));
 }finally{Gateway.prototype.poll=poll;}
});
test('Pairing imports configured indoor names and reuses saved gateway identity without changing profiles',async()=>{
 const poll=Gateway.prototype.poll;Gateway.prototype.poll=async()=>require('../lib/protocol').parseStatus(fixture);
 try {
  const metadata={gateway:{name:'CCM15',ip:'192.168.50.10',netmask:'255.255.255.0',router:'192.168.50.1',dhcp:true},rooms:{names:{0:'Bedroom',5:'Kitchen'},areas:[{id:1,name:'Upstairs',slots:[0,5]}]},readAt:'2026-01-01T00:00:00.000Z'};
  const saved=new Base();saved.settings={...saved.settings,host:'192.168.50.10'};saved.getData=()=>({id:'existing:a0',gatewayId:'existing',slot:0});
  const driver=new Driver();driver.getDevices=()=>[saved];driver.metadataFor=async()=>metadata;
  driver.homey={arp:{getMAC:async()=> '00:04:a3:11:22:33'}};
  const handlers={};await driver.onPair({setHandler:(id,fn)=>{handlers[id]=fn;}});
  assert.equal(await handlers.configure({host:'192.168.50.10',port:80}),9);
  const proposed=await handlers.preview_devices();
  assert.equal(proposed[0].name,'Bedroom');assert.equal(proposed[5].name,'Kitchen');assert.equal(proposed[8].name,'Midea a8');
  assert.equal(proposed[0].data.id,'existing:a0');assert.equal(proposed[0].settings.gateway_areas,'Upstairs');
  assert.equal(proposed[0].settings.gateway_mac_info,'00:04:a3:11:22:33');
  assert.ok(proposed.every(p=>p.settings.enable_control===false&&p.settings.indoor_type==='unknown'&&p.settings.vrf_policy==='none'));
  assert.equal(saved.settings.indoor_type,undefined);assert.equal(saved.store.gateway_metadata,undefined);
  await assert.rejects(handlers.configure({host:'192.168.50.10',port:80,gatewayId:'different'}),/already paired/);
  await handlers.configure({host:'192.168.50.10',port:80,importNames:false});
  assert.equal((await handlers.list_devices())[0].name,'Midea a0');
 } finally {Gateway.prototype.poll=poll;}
});
test('Pairing summary distinguishes new, partially paired and fully paired gateways by stable indoor identity',async()=>{
 const poll=Gateway.prototype.poll;Gateway.prototype.poll=async()=>require('../lib/protocol').parseStatus(fixture);
 try {
  let saved=[]; const driver=new Driver();driver.getDevices=()=>saved;driver.metadataFor=async()=>({gateway:null,rooms:null});
  const handlers={};await driver.onPair({setHandler:(id,fn)=>{handlers[id]=fn;}});
  await assert.rejects(handlers.pairing_summary(),/Configure/);
  await handlers.configure({host:'192.168.50.10',port:80,gatewayId:'stable'});
  assert.deepEqual(await handlers.pairing_summary(),{total:9,alreadyPaired:0,available:9});
  const existing=id=>({getData:()=>({id}),getSettings:()=>({enable_control:true})});
  saved=[existing('stable:a0'),existing('stable:a5'),existing('different:a0')];
  assert.deepEqual(await handlers.pairing_summary(),{total:9,alreadyPaired:2,available:7});
  saved=Array.from({length:9},(_,slot)=>existing(`stable:a${slot}`));
  assert.deepEqual(await handlers.pairing_summary(),{total:9,alreadyPaired:9,available:0});
  assert.ok(saved.every(device=>device.getSettings().enable_control));
 }finally{Gateway.prototype.poll=poll;}
});
test('Pairing native discovery returns immediately, verifies MAC candidates and supports cancellation',async()=>{
 const driver=new Driver();driver.getDevices=()=>[];
 driver.homey={cloud:{getLocalAddress:async()=> 'http://192.168.50.2:80'},discovery:{getStrategy:()=>({getDiscoveryResults:()=>({one:{id:'00:04:a3:11:22:33',address:'192.168.50.10'}})})},arp:{getMAC:async()=>{throw new Error('ARP should be unnecessary');}}};
 const entered=deferred(),gate=deferred();let reads=0;
 driver.probe=async(host,port,{signal})=>{reads++;entered.resolve();await gate.promise;if(signal.aborted)throw new Error('cancelled');return {host,port,indoorCount:9,metadata:{gateway:null,rooms:null}};};
 const handlers={};await driver.onPair({setHandler:(id,fn)=>{handlers[id]=fn;}});
 assert.equal((await handlers.discovery_context()).range,'192.168.50.0/24');
 const admitted=await handlers.start_search({port:80});assert.ok(admitted.id);await entered.promise;
 assert.notEqual((await handlers.search_status()).phase,'done');gate.resolve();
 for(let i=0;i<20&&(await handlers.search_status()).phase!=='done';i++) await new Promise(resolve=>setImmediate(resolve));
 const result=await handlers.search_status();assert.equal(result.phase,'done');assert.equal(result.found.length,1);
 assert.equal(result.found[0].source,'mac');assert.equal(result.found[0].mac,'00:04:a3:11:22:33');assert.equal(reads,1);
 await assert.rejects(handlers.start_search({cidr:'8.8.8.0/24'}),/private/);
 driver.probe=async(_,__,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
 await handlers.start_search({port:80});await new Promise(resolve=>setImmediate(resolve));await handlers.cancel_search();
 for(let i=0;i<20&&(await handlers.search_status()).phase!=='done';i++) await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await handlers.search_status()).cancelled,true);
});
test('An explicit full-range search works without saved addresses or MAC candidates',async()=>{
 const driver=new Driver();let candidateLookups=0;
 driver.discoveryCandidates=async()=>{candidateLookups++;throw new Error('Native discovery unavailable');};driver.homey={arp:{getMAC:async()=>null}};
 const contacted=[];driver.probe=async(host,port)=>{contacted.push(host);return {host,port,indoorCount:1,slots:[0],metadata:{gateway:null,rooms:null}};};
 const handlers={};await driver.onPair({setHandler:(id,fn)=>{handlers[id]=fn;}});
 await assert.rejects(handlers.start_search({scanAll:true}),/local network range/);
 await handlers.start_search({cidr:'192.168.50.10/32',scanAll:true,port:80});
 for(let i=0;i<20&&(await handlers.search_status()).phase!=='done';i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(candidateLookups,0);assert.deepEqual(contacted,['192.168.50.10']);
 assert.equal((await handlers.search_status()).found[0].source,'network');
});
test('Nine indoor initializations share one metadata read and apply only read-only labels, preserving control and names',async()=>{
 const {app,homey}=environment();await app.onInit();homey.arp={getMAC:async()=> '00:04:a3:11:22:33'};
 let reads=0;app.readGatewayMetadata=async()=>{reads++;return {gateway:{name:'CCM15',ip:'192.168.50.10',netmask:'255.255.255.0',router:'192.168.50.1',dhcp:true},rooms:{names:{0:'Bedroom'},areas:[]},readAt:'2026-01-01T00:00:00.000Z'};};
 const devices=Array.from({length:9},(_,slot)=>{const d=new Device();d.homey=homey;d.name='My room '+slot;d.getData=()=>({id:`saved:a${slot}`,gatewayId:'saved',slot});d.settings={...d.settings,host:'192.168.50.10',enable_control:true,extras_policy:'preserve',indoor_type:'ducted'};d.client=app.attach(d);d.labelWrites=0;d.setSettings=async patch=>{assert.ok(Object.keys(patch).every(k=>k.startsWith('gateway_')));d.labelWrites++;Object.assign(d.settings,patch);};return d;});
 await Promise.all(devices.map(d=>app.refreshGatewayMetadata(d.client)));
 assert.equal(reads,1);assert.ok(devices.every(d=>d.labelWrites===1&&d.settings.enable_control&&d.settings.indoor_type==='ducted'));
 assert.equal(devices[0].name,'My room 0');assert.equal(devices[0].getData().id,'saved:a0');
 assert.equal(devices[0].settings.gateway_indoor_name,'Bedroom');assert.equal(devices[0].store.gateway_mac,'00:04:a3:11:22:33');
 await app.refreshGatewayMetadata(devices[0].client);assert.equal(reads,1);assert.equal(devices[0].labelWrites,1);
});
test('Metadata recovers after a gateway starts offline, preserves previous labels on failure and refreshes its bounded cache',async()=>{
 const {app,homey}=environment();await app.onInit();homey.arp={getMAC:async()=>null};
 const d=new Device();d.homey=homey;d.client=app.attach(d);d.settings.gateway_indoor_name='Existing gateway label';
 d.store.gateway_metadata={gateway:null,rooms:{names:{0:'Existing gateway label'},areas:[]}};
 let reads=0;app.readGatewayMetadata=async()=>{reads++;return reads===1?{gateway:null,rooms:null}:{gateway:{name:'CCM15',ip:'192.168.50.10',netmask:'255.255.255.0',router:'192.168.50.1',dhcp:true},rooms:{names:{0:'New gateway label'},areas:[]}};};
 await app.refreshGatewayMetadata(d.client);assert.equal(d.settings.gateway_indoor_name,'Existing gateway label');
 await app.refreshGatewayMetadata(d.client);assert.equal(reads,1);
 app.gateways.get(d.gatewayKey).metadataExpiresAt=0;app.refresh=async()=>true;await app.pollAll();
 assert.equal(reads,2);assert.equal(d.settings.gateway_indoor_name,'New gateway label');
 await app.pollAll();assert.equal(reads,2);
});
test('Device settings reject enabling control before firmware policy confirmation',async()=>{
 const d=new Device();await assert.rejects(d.onSettings({newSettings:{...d.settings,enable_control:true}}),/policy/);
});
test('Duct profile removes swing and unconfirmed auxiliary heater controls',async()=>{
 const d=new Device();await d.applyCapabilityProfile({indoor_type:'ducted',heater_supported:false});
 assert.equal(d.hasCapability('ccm15_swing'),false);assert.equal(d.hasCapability('ccm15_heater'),false);
 await assert.rejects(d.change({swing:true}),/wall split/);
 await d.applyCapabilityProfile({indoor_type:'wall_split',heater_supported:false});
 assert.equal(d.hasCapability('ccm15_swing'),true);assert.equal(d.hasCapability('ccm15_heater'),false);
  assert.equal(typeof d.listeners.ccm15_swing,'function');
});
test('Device passes explicit shared outdoor membership to serialized gateway commands',async()=>{
 const {app,homey}=environment();await app.onInit();const d=new Device();d.homey=homey;
 d.settings={...d.settings,enable_control:true,extras_policy:'preserve',vrf_policy:'heat_pump',vrf_group_slots:'a0,a1'};
 let seen;d.client={change:async(slot,patch,options)=>{seen={slot,patch,options};return new Map();}};
 await d.change({target:23});assert.deepEqual(seen.options.heatPumpSlots,[0,1]);assert.equal(seen.slot,0);
 d.settings.vrf_group_slots='a1';let calls=0;d.client.change=async()=>{calls++;};d.refresh=async()=>{};
 await assert.rejects(d.change({mode:'heat'}),/contain this indoor/);assert.equal(calls,0);
});

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const stateXml=(mode=1,fan=3,temp=26)=>`<response><a0>${Buffer.from([0,0,0,(mode<<2)|(fan<<5)|(mode===4?0:1),temp<<3,0,25]).toString('hex')}</a0></response>`;
async function controlledDevice(){
 const env=environment();await env.app.onInit();const d=new Device();d.homey=env.homey;d.refresh=async()=>{};
 d.settings={...d.settings,enable_control:true,extras_policy:'preserve',indoor_type:'ducted'};await d.onInit();
 return {...env,d};
}
test('UI acknowledges a draft before any network IO, then queues only after a quiet second', {timeout:2000}, async()=>{
 const {d,homey,triggers,clock}=await controlledDevice();const gate=deferred();let actual=stateXml(),writes=0,reads=0;
 await d.updateState(decode('00000065d00019',0)); // heat / medium / 26°C
 d.client.tail=gate.promise;d.client.sleep=async()=>{};
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;actual=stateXml(4,3,26);return '';}reads++;return actual;};
 try{
  const before=d.values.onoff;await d.listeners.onoff(false);
  assert.equal(writes,0);assert.equal(reads,0);assert.equal(d.values.onoff,before);assert.equal(d.values.ccm15_command_status,'selecting');
  assert.equal(homey.settings.get('command_diagnostics'),undefined);
  await clock.advance(999);assert.equal(d.controlTasks.size,0);await clock.advance(1);assert.equal(d.values.ccm15_command_status,'queued');
  gate.resolve();await drainUi(d);
  assert.equal(writes,1);assert.equal(d.values.onoff,false);assert.equal(d.values.ccm15_command_status,'confirmed');
  assert.equal(triggers.filter(t=>t.id==='command_result').length,1);
 }finally{gate.resolve();}
});
test('UI reports a later failure through device warning and Flow, without optimistic values or resend', {timeout:2000}, async()=>{
 const {d,homey,triggers,clock}=await controlledDevice();const gate=deferred(),entered=deferred();let writes=0;
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return stateXml();};
 d.client.sleep=async()=>{entered.resolve();await gate.promise;};
 await d.updateState(decode('00000065d00019',0));
 await d.listeners.target_temperature(23);await clock.advance(1000);await entered.promise;assert.equal(d.values.target_temperature,26);
 assert.equal(d.values.ccm15_command_status,'pending');
 gate.resolve();await drainUi(d);
 assert.equal(writes,1);assert.equal(d.values.target_temperature,26);assert.equal(d.values.ccm15_command_status,'unconfirmed');
 assert.match(d.warning,/target: expected 23, reported 26/);
 assert.equal(homey.settings.get('command_diagnostics').length,1);
 assert.ok(triggers.some(t=>t.id==='command_result'&&t.tokens.status==='unconfirmed'));
});
test('Flow actions still await confirmed state and a result Flow may safely read the same queue', {timeout:2000}, async()=>{
 const {d,homey,actions}=await controlledDevice();const gate=deferred(),entered=deferred();let actual=stateXml(),writes=0,settled=false,resultRead;
 const original=homey.flow.getDeviceTriggerCard;
 homey.flow.getDeviceTriggerCard=id=>id==='command_result'?{trigger:()=>{resultRead=d.client.poll();return resultRead;}}:original(id);
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;actual=stateXml(1,3,23);return '';}return actual;};
 d.client.sleep=async()=>{entered.resolve();await gate.promise;};
 const completion=actions.set_temperature({device:d,temperature:23}).then(v=>{settled=true;return v;});
 await entered.promise;assert.equal(settled,false);assert.equal(d.values.target_temperature,26);
 gate.resolve();assert.equal(await completion,true);await resultRead;
 assert.equal(writes,1);assert.equal(d.values.target_temperature,23);
});
test('An older result is retained in history without replacing the latest queued status', async()=>{
 const {app,homey,triggers}=environment();await app.onInit();const d=new Device();d.homey=homey;d.latestCommandId='new';
 await app.recordCommand(d,{commandId:'new',kind:'climate',slot:0,status:'queued',durationMs:0,observations:[]});
 await app.recordCommand(d,{commandId:'old',kind:'climate',slot:0,status:'confirmed',durationMs:15500,observations:[{}]});
 assert.equal(d.values.ccm15_command_status,'queued');assert.equal(homey.settings.get('command_diagnostics')[0].commandId,'old');
 assert.equal(triggers.at(-1).tokens.command_id,'old');
});
test('Deleting a device or stopping the app cancels queued control before any write', {timeout:2000}, async()=>{
 for(const stop of ['device','app','permission']){
  const {d,app,homey,clock}=await controlledDevice();const gate=deferred();let calls=0;d.client.tail=gate.promise;
  d.client.transport=async()=>{calls++;return stateXml();};
  await d.listeners.target_temperature(23);await clock.advance(1000);
  if(stop==='device')await d.onUninit();else if(stop==='app')await app.onUninit();else d.settings.enable_control=false;
  gate.resolve();await drainUi(d);
  assert.equal(calls,0);const record=homey.settings.get('command_diagnostics').at(-1);
  assert.equal(record.status,'rejected');assert.equal(record.writes,0);
 }
});
test('UI rejects invalid values and read-only control immediately, before queue admission', async()=>{
 const {d}=await controlledDevice();let calls=0;d.client.transport=async()=>{calls++;return stateXml();};
 await assert.rejects(d.listeners.target_temperature(22.5),/integer/);
 await assert.rejects(d.listeners.ccm15_mode_restriction('unknown'),/Choose Cool/);
 await assert.rejects(d.listeners.ccm15_heating_limit_control('unknown'),/Temperature limits/);
 d.settings.enable_control=false;await assert.rejects(d.listeners.onoff(true),/Read-only/);
 assert.equal(calls,0);assert.equal(d.controlTasks.size,0);
});
test('Restarting does not replay a pending command, and unchanged sensor values are not rewritten', async()=>{
 const {app,homey}=environment();await app.onInit();const d=new Device();d.homey=homey;d.refresh=async()=>{};
 d.values.ccm15_command_status='pending';await d.onInit();assert.equal(d.values.ccm15_command_status,'unconfirmed');assert.match(d.warning,/restarted/);
 assert.equal(d.controlTasks.size,0);
 const state=decode('00000065d00019',0);await d.updateState(state);const changed=[];
 d.setCapabilityValue=async(k,v)=>{changed.push(k);d.values[k]=v;};await d.updateState(state);
 assert.ok(changed.every(k=>k==='ccm15_last_seen'));
});

test('Scrolling through modes, fan and target sends only the final merged climate selection',async()=>{
 const {d,clock,triggers}=await controlledDevice();let actual=stateXml(),writes=[];
 await d.updateState(decode('00000065d00019',0));d.client.sleep=async()=>{};
 d.client.transport=async(h,p,path)=>{
  if(path.startsWith('/ctrl')){
   const q=new URL(path,'http://test').searchParams;writes.push(Object.fromEntries(q));
   actual=stateXml(Number(q.get('mode')),Number(q.get('fan')),Number(q.get('temp')));return '';
  }return actual;
 };
 await d.listeners.ccm15_mode('dry');await clock.advance(200);
 await d.listeners.ccm15_mode('cool');await clock.advance(200);
 await d.listeners.ccm15_mode('auto');await clock.advance(200);
 await d.listeners.ccm15_mode('heat');await d.listeners.ccm15_fan('low');await d.listeners.target_temperature(23);
 await clock.advance(999);assert.equal(writes.length,0);assert.equal(d.controlTasks.size,0);
 await clock.advance(1);await drainUi(d);
 assert.equal(writes.length,1);assert.equal(writes[0].mode,'1');assert.equal(writes[0].fan,'2');assert.equal(writes[0].temp,'23');
 assert.equal(d.values.ccm15_mode,'heat');assert.equal(d.values.ccm15_fan,'low');assert.equal(d.values.target_temperature,23);
 assert.equal(triggers.filter(t=>t.id==='command_result').length,1);
});
test('Old gateway data cannot reset active controls; real temperatures, faults and Flow conditions keep updating',async()=>{
 const {d,conditions,triggers}=await controlledDevice();await d.updateState(decode('00000065d00019',0));
 await d.listeners.ccm15_mode('cool');await d.listeners.ccm15_fan('high');await d.listeners.target_temperature(22);
 // Simulate the native control displaying the accepted selections.
 d.values.ccm15_mode='cool';d.values.ccm15_fan='high';d.values.target_temperature=22;
 await d.updateState(decode('00000465d0001b',0)); // still heat / medium / 26; room 27; E0
 assert.equal(d.values.ccm15_mode,'cool');assert.equal(d.values.ccm15_fan,'high');assert.equal(d.values.target_temperature,22);
 assert.equal(d.values.ccm15_reported_mode,'heat');assert.equal(d.values.ccm15_reported_fan,'medium');assert.equal(d.values.ccm15_reported_target,26);
 assert.equal(d.values.measure_temperature,27);assert.equal(d.values.alarm_generic,true);
 assert.equal(await conditions.is_mode({device:d,value:'cool'}),false);assert.equal(await conditions.is_mode({device:d,value:'heat'}),true);
 assert.equal(await conditions.is_fan({device:d,value:'medium'}),true);
 assert.ok(triggers.some(t=>t.id==='state_changed'&&t.tokens.mode==='heat'&&t.tokens.target===26&&t.tokens.temperature===27));
 d.uiChanges.cancel();await d.updateState(d.reportedState);
 assert.equal(d.values.ccm15_mode,'heat');assert.equal(d.values.target_temperature,26);
});
test('Controls stay stable throughout delayed confirmation and then reconcile to the reported result',async()=>{
 const {d,clock}=await controlledDevice();let actual=stateXml();const gate=deferred(),entered=deferred();
 await d.updateState(decode('00000065d00019',0));d.client.sleep=async()=>{entered.resolve();await gate.promise;};
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl'))return '';return actual;};
 await d.listeners.target_temperature(23);d.values.target_temperature=23;
 await clock.advance(1000);await entered.promise;
 assert.equal(d.values.target_temperature,23);assert.equal(d.values.ccm15_reported_target,26);assert.equal(d.values.ccm15_command_status,'pending');
 actual=stateXml(1,3,23);gate.resolve();await drainUi(d);
 assert.equal(d.values.target_temperature,23);assert.equal(d.values.ccm15_reported_target,23);assert.equal(d.values.ccm15_command_status,'confirmed');
 assert.equal(d.uiChanges.isHolding(),false);
});
test('A failed final selection restores the real value after confirmation ends, with no resend',async()=>{
 const {d,clock}=await controlledDevice();let writes=0;await d.updateState(decode('00000065d00019',0));
 d.client.sleep=async()=>{};d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return stateXml();};
 await d.listeners.target_temperature(23);d.values.target_temperature=23;
 await clock.advance(1000);await drainUi(d);
 assert.equal(writes,1);assert.equal(d.values.target_temperature,26);assert.equal(d.values.ccm15_reported_target,26);
 assert.equal(d.values.ccm15_command_status,'unconfirmed');assert.equal(d.uiChanges.isHolding(),false);
});
test('Newer UI intent replaces an older unsent request in the gateway queue',async()=>{
 const {d,clock,homey}=await controlledDevice();const gate=deferred();let actual=stateXml(),writes=0;
 d.client.tail=gate.promise;d.client.sleep=async()=>{};
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;const q=new URL(path,'http://test').searchParams;actual=stateXml(1,3,Number(q.get('temp')));return '';}return actual;};
 await d.listeners.target_temperature(22);await clock.advance(1000);
 await d.listeners.target_temperature(23);const newestId=d.latestCommandId;
 assert.equal(d.values.ccm15_command_status,'selecting');await clock.advance(1000);
 gate.resolve();await drainUi(d);
 assert.equal(writes,1);assert.equal(d.values.target_temperature,23);assert.equal(d.latestCommandId,newestId);
 const records=homey.settings.get('command_diagnostics');assert.equal(records.length,2);
 assert.equal(records[0].writes,0);assert.equal(records[0].status,'rejected');assert.equal(records[1].status,'confirmed');
});
test('Lock wheels coalesce their own values without discarding another restriction choice',async()=>{
 const {d,clock}=await controlledDevice();const calls=[];
 d.client.setLock=async(slot,kind,value)=>{calls.push([kind,value]);return new Map();};
 await d.listeners.ccm15_cooling_limit_control('18');await clock.advance(300);
 await d.listeners.ccm15_cooling_limit_control('21');await clock.advance(300);
 await d.listeners.ccm15_heating_limit_control('27');await d.listeners.ccm15_cooling_limit_control('23');
 await clock.advance(999);assert.equal(calls.length,0);await clock.advance(1);await drainUi(d);
 assert.deepEqual(calls,[['heatLimit',27],['coolLimit',23]]);
});
test('Rapid power/mode edits preserve the last explicit power or mode intent',async()=>{
 for(const [edits,expected] of [
  [[['ccm15_mode','heat'],['onoff',false]],'off'],
  [[['onoff',false],['ccm15_mode','dry']],'dry'],
  [[['ccm15_mode','heat'],['onoff',true]],'heat'],
  [[['thermostat_mode','heat'],['onoff',false]],'off'],
  [[['onoff',false],['thermostat_mode','dry']],'dry'],
  [[['thermostat_mode','cool'],['ccm15_mode','heat']],'heat'],
  [[['ccm15_mode','heat'],['thermostat_mode','dry']],'dry'],
 ]){
  const {d,clock}=await controlledDevice();const calls=[];
  d.client.change=async(slot,patch)=>{calls.push(typeof patch==='function'?patch(decode('00000061d00019',0)):patch);return new Map();};
  for(const [cap,value] of edits)await d.listeners[cap](value);
  await clock.advance(1000);await drainUi(d);assert.equal(calls.length,1);assert.equal(calls[0].mode,expected);
 }
});
test('Deleting, stopping or changing settings cancels uncommitted wheel edits before network IO',async()=>{
 for(const action of ['device','app','settings']){
  const {d,clock,app}=await controlledDevice();let calls=0;d.client.transport=async()=>{calls++;return stateXml();};
  await d.listeners.target_temperature(23);
  if(action==='device')await d.onUninit();else if(action==='app')await app.onUninit();else await d.onSettings({newSettings:{...d.settings,enable_control:false}});
  await clock.advance(2000);assert.equal(calls,0);assert.equal(d.controlTasks.size,0);assert.equal(d.uiChanges.isHolding(),false);
 }
});
test('Disabling control during the quiet second reports refusal and sends no network request',async()=>{
 const {d,clock,homey}=await controlledDevice();let calls=0;d.client.transport=async()=>{calls++;return stateXml();};
 await d.listeners.target_temperature(23);d.settings.enable_control=false;await clock.advance(1000);await drainUi(d);
 assert.equal(calls,0);assert.equal(d.values.ccm15_command_status,'rejected');assert.equal(homey.settings.get('command_diagnostics').at(-1).writes,0);
});
test('Native Operating mode is the final picker and legacy capability and Flows remain available',()=>{
 const manifest=require('../app.json');const driver=manifest.drivers[0];
 assert.deepEqual(driver.capabilities.filter(cap=>cap==='thermostat_mode'||manifest.capabilities[cap]?.uiComponent==='picker'),
  ['ccm15_fan','ccm15_mode_restriction','ccm15_fan_restriction','ccm15_cooling_limit_control','ccm15_heating_limit_control','thermostat_mode']);
 assert.ok(driver.capabilities.includes('ccm15_mode'));assert.equal(manifest.capabilities.ccm15_mode.uiComponent,null);
 assert.equal(manifest.capabilities.ccm15_mode.setable,true);
 assert.equal(driver.capabilitiesOptions.thermostat_mode.title.en,'Operating mode');
 assert.deepEqual(driver.capabilitiesOptions.thermostat_mode.values.map(v=>v.id),['cool','heat','dry','fan','off','auto','unknown']);
 assert.equal(manifest.compatibility,'>=12.0.1');
 assert.ok(manifest.flow.actions.some(c=>c.id==='set_mode'));assert.ok(manifest.flow.conditions.some(c=>c.id==='is_mode'));
 for(const cap of ['ccm15_reported_mode','ccm15_reported_fan','ccm15_reported_target','ccm15_reported_power']){
  assert.ok(driver.capabilities.includes(cap));assert.equal(manifest.capabilities[cap].setable,false);assert.equal(manifest.capabilities[cap].uiComponent,'sensor');
 }
});
test('The native mode wheel merges final edits and both mode capabilities follow the observed result',async()=>{
 const {d,clock}=await controlledDevice();let actual=stateXml(),writes=[];
 await d.updateState(decode('00000065d00019',0));d.client.sleep=async()=>{};
 d.client.transport=async(h,p,path)=>{
  if(path.startsWith('/ctrl')){const q=new URL(path,'http://test').searchParams;writes.push(Object.fromEntries(q));
   actual=stateXml(Number(q.get('mode')),Number(q.get('fan')),Number(q.get('temp')));return '';}
  return actual;
 };
 await d.listeners.thermostat_mode('cool');d.values.thermostat_mode='cool';
 await d.updateState(decode('00000065d00019',0));assert.equal(d.values.thermostat_mode,'cool');assert.equal(d.getReportedCapabilityValue('thermostat_mode'),'heat');
 await clock.advance(250);await d.listeners.thermostat_mode('dry');await d.listeners.ccm15_fan('low');await d.listeners.target_temperature(23);
 await clock.advance(999);assert.equal(writes.length,0);await clock.advance(1);await drainUi(d);
 assert.equal(writes.length,1);assert.equal(writes[0].mode,'2');assert.equal(writes[0].fan,'2');assert.equal(writes[0].temp,'23');
 assert.equal(d.values.thermostat_mode,'dry');assert.equal(d.values.ccm15_mode,'dry');assert.equal(d.values.ccm15_reported_mode,'dry');
});
test('Existing device migration appends native mode without deleting legacy mode or re-adding existing capabilities',async()=>{
 const d=new Device();d.removed=new Set(['thermostat_mode']);const added=[],removed=[];
 d.addCapability=async id=>{added.push(id);d.removed.delete(id);};d.removeCapability=async id=>{removed.push(id);d.removed.add(id);};
 await d.applyCapabilityProfile({indoor_type:'ducted',heater_supported:false});
 assert.deepEqual(added,['thermostat_mode']);assert.ok(!removed.includes('ccm15_mode'));
 await d.applyCapabilityProfile({indoor_type:'ducted',heater_supported:false});assert.deepEqual(added,['thermostat_mode']);
});
test('A late mode-unlock read clears the warning only after actual confirmation, without resending',async()=>{
 const {d,clock,homey,triggers}=await controlledDevice();const locked='00000263d00019',unlocked='00000261d00019';let writes=0;
 d.client.sleep=async()=>{};d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return `<response><a0>${locked}</a0></response>`;};
 await d.updateState(decode(locked,0));await d.listeners.ccm15_mode_restriction('unlocked');await clock.advance(1000);await drainUi(d);
 assert.equal(writes,1);assert.equal(d.values.ccm15_command_status,'unconfirmed');assert.match(d.warning,/lockedMode: expected unlocked, reported heat/);
 await d.updateState(decode(locked,0));assert.equal(d.values.ccm15_command_status,'unconfirmed');
 await d.updateState(decode(unlocked,0));assert.equal(d.values.ccm15_command_status,'confirmed');assert.equal(d.warning,null);
 assert.match(d.values.ccm15_command_detail,/later gateway read/);assert.equal(writes,1);
 const records=homey.settings.get('command_diagnostics');assert.equal(records.length,2);assert.equal(records[0].status,'unconfirmed');assert.equal(records[1].confirmedLate,true);
 assert.equal(records[1].commandId,records[0].commandId);assert.equal(records[1].observations.at(-1).source,'later_read');
 assert.equal(triggers.filter(t=>t.id==='command_result').length,2);
 await d.updateState(decode(unlocked,0));assert.equal(homey.settings.get('command_diagnostics').length,2);
});
test('A new selection or expired confirmation window prevents an old request from claiming a later read',async()=>{
 for(const action of ['new_selection','expiry','fault']){
  const {d,clock,homey}=await controlledDevice();d.client.sleep=async()=>{};let writes=0;
  d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return stateXml();};
  await d.listeners.target_temperature(23);await clock.advance(1000);await drainUi(d);assert.equal(d.values.ccm15_command_status,'unconfirmed');
  if(action==='new_selection')await d.listeners.target_temperature(24);
  else if(action==='expiry')d.unconfirmedCommand.expiresAt=Date.now()-1;
  const raw=Buffer.from([0,0,action==='fault'?4:0,0x65,23<<3,0,25]).toString('hex');await d.updateState(decode(raw,0));
  assert.equal(d.values.ccm15_command_status,action==='new_selection'?'selecting':'unconfirmed');
  assert.equal(homey.settings.get('command_diagnostics').length,1);assert.equal(writes,1);d.uiChanges.cancel();
 }
});
test('Restart resumes a recent confirmation read, clears prior warning on a new selection, and never replays a write',async()=>{
 const {d,clock,homey}=await controlledDevice();d.client.sleep=async()=>{};let writes=0;
 d.client.transport=async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return stateXml();};
 await d.listeners.target_temperature(23);await clock.advance(1000);await drainUi(d);assert.equal(writes,1);
 await d.onUninit();await d.onInit();assert.ok(d.unconfirmedCommand);
 await d.updateState(decode(Buffer.from([0,0,0,0x65,23<<3,0,25]).toString('hex'),0));
 assert.equal(d.values.ccm15_command_status,'confirmed');assert.equal(writes,1);assert.equal(d.warning,null);
 const history=homey.settings.get('command_diagnostics');assert.equal(history.at(-1).confirmedLate,true);
 d.values.ccm15_command_status='unconfirmed';d.values.ccm15_command_detail='Previous failure';d.warning='Previous failure';
 await d.onUninit();await d.onInit();await d.listeners.target_temperature(24);assert.equal(d.warning,null);d.uiChanges.cancel();
});
