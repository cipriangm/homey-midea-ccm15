'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const http=require('node:http'); const {Gateway,request}=require('../lib/gateway');
const xml=(mode=4,fan=0,temp=26)=>`<response><a0>${Buffer.from([0,0,0,(mode<<2)|(fan<<5)|(mode===4?0:1),temp<<3,0,25]).toString('hex')},</a0></response>`;
const options={controlEnabled:true,extrasPolicy:'preserve'};
test('Default read-only gate never calls transport',async()=>{
  const paths=[];const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);return xml();});
  await assert.rejects(g.change(0,{target:23}),/Read-only/);assert.equal(paths.length,0);
  assert.equal((await g.poll()).size,1);assert.deepEqual(paths,['/status.xml']);
});
test('Fresh read, full write, read-back; no extra write',async()=>{
  const paths=[];let current=xml(1,3,26);
  const g=new Gateway('localhost',80,async(h,p,path)=>{
    paths.push(path);if(path.startsWith('/ctrl')){const q=new URLSearchParams(path.split('?')[1]);current=xml(+q.get('mode'),+q.get('fan'),+q.get('temp'));return '<response><ret>0</ret></response>'; }return current;
  },async()=>{});
  const state=(await g.change(0,{target:23},options)).get(0);
  assert.equal(state.target,23);assert.equal(state.mode,'heat');assert.equal(state.fan,'medium');
  assert.deepEqual(paths.map(p=>p.split('?')[0]),['/status.xml','/ctrl.xml','/status.xml']);
});
test('Concurrent commands serialize and preserve newly updated settings',async()=>{
  const paths=[];let current=xml(1,3,26);
  const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);if(path.startsWith('/ctrl')){const q=new URLSearchParams(path.split('?')[1]);current=xml(+q.get('mode'),+q.get('fan'),+q.get('temp'));return '';}return current;},async()=>{});
  await Promise.all([g.change(0,{fan:'low'},options),g.change(0,{target:23},options)]);
  const writes=paths.filter(p=>p.startsWith('/ctrl'));assert.equal(writes.length,2);assert.match(writes[1],/fan=2/);
});
test('Missing slot and read failure prevent write; queue recovers',async()=>{
  let current='<response><a0>-</a0></response>';const paths=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);return current;},async()=>{});
  await assert.rejects(g.change(0,{target:23},options),/absent/);assert.ok(paths.every(p=>p==='/status.xml'));
  current=xml();assert.equal((await g.poll()).size,1);
});
test('Wrong password and unconfirmed write fail without retrying control',async()=>{
  for(const ret of ['<ret>250</ret>','<ret>0</ret>','<html>unexpected body</html>']) {
    const paths=[];const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);return path.startsWith('/ctrl')?ret:xml();},async()=>{});
    await assert.rejects(g.change(0,{target:23},options),ret.includes('250')?/password/:/not confirmed/);
    assert.equal(paths.filter(p=>p.startsWith('/ctrl')).length,1);
  }
});
test('Read-back detects unexpected changes in auxiliary bits',async()=>{
  const g=new Gateway('localhost',80,async(h,p,path)=>path.startsWith('/ctrl')?'':xml(0),async()=>{});
  await assert.rejects(g.change(0,{swing:true},options),/not confirmed/);
});
test('Power Off permits swing to stop, preserves the wire setting and still checks other fields',async()=>{
 for(const mismatch of [false,true]){
  let current=xml(0).replace('d000','d200');const paths=[],events=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{
   paths.push(path);if(path.startsWith('/ctrl')){current=xml(4,0,mismatch?25:26);return '';}return current;
  },async()=>{});
  if(mismatch)await assert.rejects(g.change(0,{mode:'off'},{...options,onDiagnostic:d=>events.push(d)}),/target: expected 26, reported 25/);
  else assert.equal((await g.change(0,{mode:'off'},{...options,onDiagnostic:d=>events.push(d)})).get(0).swing,false);
  assert.equal(paths.filter(p=>p.startsWith('/ctrl')).length,1);assert.match(paths.find(p=>p.startsWith('/ctrl')),/sw=1/);
  assert.equal(events.at(-1).offSwingStopped,true);assert.deepEqual(events.at(-1).mismatches,mismatch?['target']:[]);
 }
});
test('Only a stopped fan on verified power Off is accepted; running speeds and other Off fields remain strict',async()=>{
 for(const [requested,actualMode,actualFan,accepted] of [['off',4,5,true],['off',4,3,false],['cool',0,5,false],['off',0,5,false]]){
  let current=xml(0,2,26);const paths=[],events=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{
   paths.push(path);if(path.startsWith('/ctrl')){current=xml(actualMode,actualFan,26);return '';}return current;
  },async()=>{});
  if(accepted)assert.equal((await g.change(0,{mode:requested},{...options,onDiagnostic:d=>events.push(d)})).get(0).fan,'off');
  else await assert.rejects(g.change(0,{mode:requested},{...options,onDiagnostic:d=>events.push(d)}),/not confirmed/);
  assert.equal(paths.filter(p=>p.startsWith('/ctrl')).length,1);assert.match(paths.find(p=>p.startsWith('/ctrl')),/fan=2/);
  assert.equal(events.at(-1).offFanStopped,accepted);
 }
 const {differences}=require('../lib/gateway');
 assert.deepEqual(differences({mode:'off',fan:'low',target:26,heater:false},{mode:'off',fan:'off',target:25,heater:true}),['target','heater']);
});
test('HTTP transport reads local mock, rejects redirect and enforces deadline',async t=>{
  const server=http.createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:'/ctrl.xml'});res.end();}else if(req.url==='/hang'){}else res.end(xml());});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const port=server.address().port;
  assert.equal((await new Gateway('127.0.0.1',port).poll()).size,1);
  await assert.rejects(request('127.0.0.1',port,'/redirect'),/302/);
  await assert.rejects(request('127.0.0.1',port,'/hang',30),/timeout/);
});
test('Control HTTP 302 is verified by state without following Location or resending',async t=>{
  for(const outcome of ['applied','unchanged','wrong_password']) await t.test(outcome,async t=>{
    const paths=[];let current=xml(1,3,26);
    const server=http.createServer((req,res)=>{
      paths.push(req.url);
      if(req.url.startsWith('/ctrl.xml?')){
        if(outcome==='applied'){
          const q=new URLSearchParams(req.url.split('?')[1]);
          current=xml(+q.get('mode'),+q.get('fan'),+q.get('temp'));
        }
        res.writeHead(302,{Location:'/must-never-be-followed'});
        res.end(outcome==='wrong_password'?'<response><ret>250</ret></response>':'<html>command response</html>');
      }else res.end(current);
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
    const g=new Gateway('127.0.0.1',server.address().port,request,async()=>{});
    if(outcome==='applied'){
      const state=(await g.change(0,{target:23},options)).get(0);
      assert.equal(state.target,23);assert.equal(state.mode,'heat');assert.equal(state.fan,'medium');
    }else await assert.rejects(g.change(0,{target:23},options),outcome==='wrong_password'?/password/:/not confirmed/);
    assert.equal(paths.filter(p=>p.startsWith('/ctrl.xml?')).length,1);
    assert.ok(paths.every(p=>p==='/status.xml'||p.startsWith('/ctrl.xml?')));
    assert.equal(paths.filter(p=>p==='/status.xml').length,outcome==='applied'?2:outcome==='unchanged'?10:1);
  });
});
test('Delayed state beyond three reads confirms without a second control request',async()=>{
  const paths=[],delays=[],events=[];let readsAfterWrite=0,writing=false;
  const g=new Gateway('localhost',80,async(h,p,path)=>{
    paths.push(path);if(path.startsWith('/ctrl')){writing=true;return '<ret>1</ret>';}
    return writing&&++readsAfterWrite>=5?xml(1,3,23):xml(1,3,26);
  },async ms=>{delays.push(ms);});
  const actual=(await g.change(0,{target:23},{...options,onDiagnostic:d=>events.push(d)})).get(0);
  assert.equal(actual.target,23);assert.equal(paths.filter(p=>p.startsWith('/ctrl')).length,1);
  assert.deepEqual(delays,[1000,1000,2000,3000,4000]);
  assert.equal(events.at(-1).status,'confirmed');assert.equal(events.at(-1).responseCode,1);
  assert.equal(events.at(-1).observations.length,5);
});
test('A transient status failure during confirmation does not resend or abandon a later result',async()=>{
  let writing=false,reads=0,writes=0;const events=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{
    if(path.startsWith('/ctrl')){writing=true;writes++;return '';}
    if(writing&&++reads===1)throw new Error('Gateway timeout');
    return writing?xml(1,3,23):xml(1,3,26);
  },async()=>{});
  assert.equal((await g.change(0,{target:23},{...options,onDiagnostic:d=>events.push(d)})).get(0).target,23);
  assert.equal(writes,1);assert.equal(events.at(-1).observations[0].readFailed,true);
});
test('Real-time budget accepts a gateway update after the former 16-second window without resending',async t=>{
  t.mock.timers.enable({apis:['Date'],now:0});
  let wroteAt=null,writes=0;const events=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{
    if(path.startsWith('/ctrl')){writes++;wroteAt=Date.now();return '';}
    return wroteAt!==null&&Date.now()-wroteAt>=20000?xml(1,3,23):xml(1,3,26);
  },async ms=>t.mock.timers.tick(ms));
  const final=(await g.change(0,{target:23},{...options,onDiagnostic:d=>events.push(d)})).get(0);
  assert.equal(final.target,23);assert.equal(writes,1);assert.equal(events.at(-1).status,'confirmed');
  assert.equal(events.at(-1).durationMs,23000);assert.equal(events.at(-1).observations.length,8);
});
test('Unconfirmed commands record specific mismatches without credentials',async()=>{
  const events=[];let writes=0;
  const g=new Gateway('localhost',80,async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;return '';}return xml(1,3,26);},async()=>{});
  await assert.rejects(g.change(0,{target:23},{...options,password:'123456',onDiagnostic:d=>events.push(d)}),/target: expected 23, reported 26/);
  assert.equal(writes,1);assert.equal(events.at(-1).status,'unconfirmed');assert.deepEqual(events.at(-1).mismatches,['target']);
  assert.ok(!JSON.stringify(events).includes('123456'));assert.ok(!JSON.stringify(events).includes('pwd='));
});
test('Diagnostic storage failure does not change an applied command result',async()=>{
  let writing=false,writes=0;const g=new Gateway('localhost',80,async(h,p,path)=>{if(path.startsWith('/ctrl')){writing=true;writes++;return '';}return writing?xml(1,3,23):xml(1,3,26);},async()=>{});
  assert.equal((await g.change(0,{target:23},{...options,onDiagnostic:()=>{throw new Error('storage unavailable');}})).get(0).target,23);assert.equal(writes,1);
});
test('A lost HTTP response still permits later state confirmation with exactly one dispatch',async()=>{
  let writes=0;const events=[],published=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{if(path.startsWith('/ctrl')){writes++;throw new Error('Gateway timeout');}return writes?xml(1,3,23):xml(1,3,26);},async()=>{});
  assert.equal((await g.change(0,{target:23},{...options,onDiagnostic:d=>events.push(d),onStates:s=>published.push(s.get(0).target)})).get(0).target,23);
  assert.equal(writes,1);assert.equal(events.at(-1).status,'confirmed');assert.equal(events.at(-1).transportError,'Gateway timeout');
  assert.deepEqual(published,[26,23]);
});
test('A settings change while reading cancels before dispatch; queue stays usable',async()=>{
  let maySend=true;const paths=[],events=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);maySend=false;return xml(1,3,26);},async()=>{});
  await assert.rejects(g.change(0,{target:23},{...options,shouldSend:()=>maySend,onDiagnostic:d=>events.push(d)}),/cancelled before dispatch/);
  assert.deepEqual(paths,['/status.xml']);assert.equal(events.at(-1).writes,0);assert.equal(events.at(-1).status,'rejected');
  assert.equal((await g.poll()).size,1);
});
test('Every confirmation read publishes actual partial changes rather than the expected state',async()=>{
  let written=false,reads=0;const published=[];
  const g=new Gateway('localhost',80,async(h,p,path)=>{if(path.startsWith('/ctrl')){written=true;return '';}return written?xml(1,++reads>=2?2:3,23):xml(1,3,26);},async()=>{});
  const final=await g.change(0,{target:23,fan:'low'},{...options,onStates:s=>published.push([s.get(0).target,s.get(0).fan])});
  assert.deepEqual(published,[[26,'medium'],[23,'medium'],[23,'low']]);assert.equal(final.get(0).fan,'low');
});
test('All five lock types and unlocks use one separate request and verified state',async()=>{
  for(const [kind,value] of [['mode','cool'],['fan','medium'],['coolLimit',20],['heatLimit',27],['remote',true]]){
    let bytes=Buffer.from([0,0,0,1|4,26<<3,0,25]);const paths=[];
    const g=new Gateway('localhost',80,async(h,p,path)=>{
      paths.push(path);if(!path.startsWith('/ctrl'))return `<response><a0>${bytes.toString('hex')}</a0></response>`;
      const q=new URLSearchParams(path.split('?')[1]),c=+q.get('lock'),v=+q.get('p'),unlock=v===99;
      for(const field of ['mode','fan','temp','sw','ht'])assert.equal(q.has(field),false);
      if(c===1){bytes[2]=(bytes[2]&252)|(unlock?0:v+1);bytes[3]=unlock?bytes[3]&253:bytes[3]|2;}
      if(c===6){bytes[1]=(bytes[1]&31)|(unlock?0:v<<5);bytes[5]=unlock?bytes[5]&223:bytes[5]|32;}
      if(c===4){bytes[0]=unlock?0:v<<3;bytes[5]=unlock?bytes[5]&247:bytes[5]|8;}
      if(c===5){bytes[1]=(bytes[1]&224)|(unlock?0:v);bytes[5]=unlock?bytes[5]&239:bytes[5]|16;}
      if(c===7)bytes[5]=unlock?bytes[5]&191:bytes[5]|64;
      return '';
    },async()=>{});
    let state=(await g.setLock(0,kind,value,options)).get(0);assert.equal(state.target,26);assert.equal(state.mode,'heat');assert.equal(state.fan,'auto');
    state=(await g.setLock(0,kind,null,options)).get(0);
    const key={mode:'lockedMode',fan:'lockedFan',coolLimit:'coolLimit',heatLimit:'heatLimit',remote:'remoteLocked'}[kind];
    assert.equal(state[key],kind==='remote'?false:['mode','fan'].includes(kind)?'unlocked':null);
    assert.equal(paths.filter(p=>p.startsWith('/ctrl')).length,2);
  }
});
test('Lock gate, invalid values and shared heat pump conflict never dispatch',async()=>{
  const paths=[];const g=new Gateway('localhost',80,async(h,p,path)=>{paths.push(path);return xml(0,0,26).replace('</response>','<a1>00000001d00019</a1></response>');},async()=>{});
  await assert.rejects(g.setLock(0,'remote',true),/Read-only/);assert.equal(paths.length,0);
  await assert.rejects(g.setLock(0,'coolLimit',16,options),/Temperature limits/);
  await assert.rejects(g.setLock(0,'mode','heat',{...options,heatPumpSlots:[0,1]}),/conflict/i);
  assert.ok(paths.every(p=>p==='/status.xml'));
});
test('HTTP statuses other than documented 302 remain rejected for controls',async t=>{
  for(const status of [301,307,308]){
    const paths=[];const server=http.createServer((req,res)=>{paths.push(req.url);res.writeHead(status,{Location:'/ctrl.xml?temp=18'});res.end();});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
    await assert.rejects(request('127.0.0.1',server.address().port,'/ctrl.xml?temp=23'),new RegExp(String(status)));
    assert.equal(paths.length,1);
  }
});
test('Read-back fault prevents success even if requested settings match',async()=>{
  let current=xml(1,3,26);let writes=0;
  const g=new Gateway('localhost',80,async(h,p,path)=>{
    if(path.startsWith('/ctrl')){
      writes++;current=xml(1,3,23).replace('000000','000004');return '';
    }
    return current;
  },async()=>{});
  await assert.rejects(g.change(0,{target:23},options),/Indoor fault 1/);
  assert.equal(writes,1);
});
