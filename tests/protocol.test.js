'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { decode, parseStatus, command, lockCommand, faultLabel, MODES, FANS } = require('../lib/protocol');
const fixture = fs.readFileSync(`${__dirname}/fixtures/live-status.xml`, 'utf8');
const base = decode('00000010d0001a,', 0);
const opts = { extrasPolicy: 'preserve' };
test('Captured live XML: nine actual slots and expected decoded values', () => {
  const states = parseStatus(fixture);
  assert.deepEqual([...states.keys()], [0,1,2,3,4,5,6,7,8]);
  assert.deepEqual([...states.values()].map(s => s.measured), [26,25,26,25,26,26,29,27,25]);
  assert.deepEqual([...states.values()].map(s => s.target), [26,21,24,24,26,26,26,26,26]);
  assert.ok([...states.values()].every(s => s.mode === 'off' && !s.on && !s.errorCode));
  assert.equal(states.get(1).fan, 'off');
});
test('Sparse addresses retain their true slot', () => {
  const states = parseStatus('<response><a0>-</a0><a32>00000010d0001a,</a32><a63>00000010d0001a,</a63></response>');
  assert.deepEqual([...states.keys()], [32,63]);
});
test('Malformed, truncated, duplicate, entity and out-of-range XML rejected', () => {
  for (const xml of ['', '<response/>', '<response><a0>00</a0></response>', '<response><a64>-</a64></response>',
    '<response><a0>-</a0><a0>-</a0></response>', '<response><a0>&foo;</a0></response>',
    '<!DOCTYPE response><response><a0>-</a0></response>', '<response><a0>-</a1></response>']) assert.throws(() => parseStatus(xml));
  assert.equal(parseStatus('<response><a0>-</a0></response>').size, 0);
});
test('All documented mode/fan bitfields and unknown values', () => {
  for (const [mode, mc] of Object.entries(MODES)) for (const [fan, fc] of Object.entries(FANS)) {
    const b = Buffer.from([0,0,0,1|(mc<<2)|(fc<<5),24<<3,0,25]);
    const s = decode(b.toString('hex'), 0);
    assert.equal(s.mode, mode); assert.equal(s.fan, fan);
  }
  assert.equal(decode('0000003dc00019',0).mode, 'unknown');
  assert.equal(decode('00000020c00019',0).fan, 'unknown');
});
test('Signed current temperature, Fahrenheit display offset converted to Celsius', () => {
  assert.equal(decode('00000010d000ff',0).measured, -1);
  const s=decode('01000010a00048',0);
  assert.equal(s.targetRaw,82); assert.equal(s.measured, (72-32)*5/9);
  assert.equal(s.target,(82-32)*5/9);
  assert.throws(() => command(0,s,{target:24},opts), /Fahrenheit/);
});
test('Fault, locks, swing, heater and limits decode independently', () => {
  const s=decode(Buffer.from([17<<3,(3<<5)|29,(5<<2)|2,2|(1<<2)|(3<<5),(24<<3)|3,8|16|32|64,25]).toString('hex'),0);
  assert.equal(s.errorCode,5); assert.equal(s.coolLimit,17); assert.equal(s.heatLimit,29);
  for (const f of ['modeLocked','fanLocked','remoteLocked','swing','heater']) assert.equal(s[f],true);
  assert.equal(s.lockedModeCode,2); assert.equal(s.lockedFanCode,3);
});
test('Unsigned masks target exactly one of all 64 addresses', () => {
  for(let slot=0;slot<64;slot++) {
    const q=new URLSearchParams(command(slot,{...base,slot},{target:23},opts).path.split('?')[1]);
    assert.equal(q.get('ac0'),String(slot<32?2**slot:0));
    assert.equal(q.get('ac1'),String(slot>=32?2**(slot-32):0));
  }
});
test('Temperature-only write preserves mode, fan, swing and heater', () => {
  const s=decode('0000006dcb0019',0); // power on, fan medium, fan-only, target 25, auxiliary flags on
  const q=new URLSearchParams(command(0,s,{target:22},opts).path.split('?')[1]);
  assert.equal(q.get('mode'),'3'); assert.equal(q.get('fan'),'3'); assert.equal(q.get('temp'),'22');
  assert.equal(q.get('sw'),'1'); assert.equal(q.get('ht'),'1');
});
test('Live firmware power bit overrides a retained active mode when Off', () => {
  const off = decode('00000004c00019', 0);
  assert.equal(off.reportedModeCode, 1); assert.equal(off.mode, 'off'); assert.equal(off.on, false);
  const on = decode('00000005c00019', 0);
  assert.equal(on.mode, 'heat'); assert.equal(on.on, true);
});
test('Starting with Off fan normalizes to Auto; stopping preserves Off fan', () => {
  const s=decode('000000b0a80019',1);
  assert.equal(command(1,s,{mode:'heat'},opts).expected.fan,'auto');
  assert.equal(command(1,s,{target:23},opts).expected.fan,'off');
});
test('Explicit Fan Off cannot silently become Auto, and swing On requires an active indoor',()=>{
  const running={...base,mode:'cool',fan:'auto'};
  assert.throws(()=>command(0,running,{fan:'off'},opts),/Fan Off is available only/);
  assert.throws(()=>command(0,base,{mode:'cool',fan:'off'},opts),/Fan Off is available only/);
  assert.equal(command(0,base,{fan:'off'},opts).expected.fan,'off');
  assert.throws(()=>command(0,base,{swing:true},opts),/Turn the indoor on/);
  assert.equal(command(0,base,{mode:'cool',swing:true},opts).expected.swing,true);
});
test('Refuse unsupported fields, unknown state, locks, invalid targets and unverified extras', () => {
  for(const patch of [{mode:'turbo'},{mode:'toString'},{target:16},{target:31},{target:23.5},{target:NaN},{humidity:40}]) assert.throws(()=>command(0,base,patch,opts));
  for(const state of [{...base,mode:'unknown'},{...base,fan:'unknown'},{...base,errorCode:1}]) assert.throws(()=>command(0,state,{target:23},opts));
  assert.throws(()=>command(0,base,{target:23}));
  assert.throws(()=>command(0,{...base,modeLocked:true},{mode:'heat'},opts));
  assert.throws(()=>command(0,{...base,fanLocked:true},{fan:'low'},opts));
  assert.throws(()=>command(0,{...base,coolLimit:25},{mode:'cool',target:23},opts));
  assert.throws(()=>command(0,{...base,heatLimit:22},{mode:'heat',target:23},opts));
  assert.throws(()=>command(0,{...base,swing:true},{target:23},{extrasPolicy:'omit'}));
});
test('Firmware lock encoding, unsigned addressing, password and unlock sentinel',()=>{
  for(let slot=0;slot<64;slot++)for(const [kind,value,code,parameter]of[['mode','cool',1,0],['mode','heat',1,1],['fan','low',6,2],['fan','medium',6,3],['fan','high',6,4],['coolLimit',20,4,20],['heatLimit',27,5,27],['remote',true,7,0]]){
    const q=new URLSearchParams(lockCommand(slot,{...base,slot},kind,value,{password:'123456',now:1234}).path.split('?')[1]);
    assert.equal(q.get('lock'),String(code));assert.equal(q.get('p'),String(parameter));assert.equal(q.get('pwd'),'296393');assert.equal(q.get('utsxxx'),'234');
    assert.equal(q.get('ac0'),String(slot<32?2**slot:0));assert.equal(q.get('ac1'),String(slot>=32?2**(slot-32):0));
    for(const k of ['mode','fan','temp','sw','ht'])assert.equal(q.has(k),false);
    assert.equal(new URLSearchParams(lockCommand(slot,{...base,slot},kind,null).path.split('?')[1]).get('p'),'99');
  }
  for(const [kind,value]of[['keyboard',true],['mode','auto'],['fan','auto'],['fan','off'],['coolLimit',16],['heatLimit',30.5],['remote','on']])assert.throws(()=>lockCommand(0,base,kind,value));
  assert.throws(()=>lockCommand(0,{...base,fahrenheit:true},'remote',true),/Fahrenheit/);
});
test('Central controls remain usable with remote lock; restrictions use locked values even when Off',()=>{
  assert.equal(command(0,{...base,remoteLocked:true},{target:23},opts).expected.target,23);
  const coolLocked={...base,modeLocked:true,lockedMode:'cool'};
  assert.equal(command(0,coolLocked,{mode:'cool'},opts).expected.mode,'cool');
  assert.equal(command(0,coolLocked,{mode:'off'},opts).expected.mode,'off');
  assert.throws(()=>command(0,coolLocked,{mode:'heat'},opts),/locked to cool/);
  const fanLocked={...base,fan:'off',fanLocked:true,lockedFan:'low'};
  assert.equal(command(0,fanLocked,{mode:'cool'},opts).expected.fan,'low');
  assert.throws(()=>command(0,fanLocked,{mode:'cool',fan:'high'},opts),/Fan is locked/);
});
test('Fault labels follow firmware mapping, not a guessed error meaning',()=>{
  for(const [code,label]of[[0,'OK'],[1,'E0'],[16,'EF'],[17,'P0'],[27,'PA'],[32,'PF'],[33,'P16'],[63,'P46']])assert.equal(faultLabel(code),label);
});
test('Password obfuscation and opt-in auxiliary commands', () => {
  const q=new URLSearchParams(command(0,{...base,mode:'cool'},{swing:true},{...opts,password:'123456',now:1234}).path.split('?')[1]);
  assert.equal(q.get('pwd'),'296393'); assert.equal(q.get('utsxxx'),'234'); assert.equal(q.get('sw'),'1');
  assert.throws(()=>command(0,base,{heater:true},opts), /hardware/);
  assert.equal(command(0,base,{heater:true},{...opts,heaterSupported:true}).expected.heater,true);
  assert.throws(()=>command(0,base,{target:23},{...opts,password:'abc'}));
});
