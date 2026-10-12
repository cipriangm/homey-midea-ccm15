'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGroupSlots, guardSharedHeatPump } = require('../lib/vrf');
const { Gateway } = require('../lib/gateway');
const modes = { cool: 0, heat: 1, dry: 2, fan: 3, off: 4, auto: 5 };
const xml = states => '<response>' + Object.entries(states).map(([slot, mode]) => `<a${slot}>${Buffer.from([0,0,0,(modes[mode]<<2)|(mode==='off'?0:1),26<<3,0,25]).toString('hex')},</a${slot}>`).join('') + '</response>';
const options = { controlEnabled: true, extrasPolicy: 'preserve', heatPumpSlots: [0,1] };
test('VRF group addresses are explicit, unique, bounded and include this device', () => {
  assert.deepEqual(parseGroupSlots('a0, 1, a63',1),[0,1,63]);
  for (const value of ['', 'a0,a0', 'a0,a64', 'a0,', 'a0,02', 'a0,1.5', 'a0,a3']) assert.throws(() => parseGroupSlots(value,1));
});
test('Heat/Cool conflicts are rejected before any physical write', async () => {
  for (const [peer, requested] of [['heat','cool'],['cool','heat'],['dry','heat'],['heat','fan'],['fan','heat'],['heat','dry']]) {
    const paths = [];
    const g = new Gateway('localhost',80,async(h,p,path) => { paths.push(path); return xml({0:'off',1:peer}); },async()=>{});
    await assert.rejects(g.change(0,{mode:requested},options),/VRF mode conflict/);
    assert.deepEqual(paths,['/status.xml']);
  }
});
test('Shared VRF allows compatible modes, an independent group, and Off', () => {
  const states = new Map([[0,{on:true,mode:'heat'}],[1,{on:true,mode:'cool'}],[2,{on:true,mode:'heat'}]]);
  assert.doesNotThrow(() => guardSharedHeatPump(states,0,'heat',[0,2]));
  assert.doesNotThrow(() => guardSharedHeatPump(states,0,'off',[0,1,3]));
  assert.doesNotThrow(() => guardSharedHeatPump(states,0,'auto',undefined));
});
test('Shared VRF refuses Auto, missing peers and uncertain active modes', () => {
  const states = new Map([[1,{on:true,mode:'auto'}]]);
  assert.throws(() => guardSharedHeatPump(states,0,'auto',[0,1]),/Independent Auto/);
  assert.throws(() => guardSharedHeatPump(states,0,'cool',[0,1]),/uncertain/);
  assert.throws(() => guardSharedHeatPump(states,0,'cool',[0,2]),/missing/);
  states.set(1,{on:false,mode:'off'});
  assert.doesNotThrow(() => guardSharedHeatPump(states,0,'heat',[0,1]));
});
test('Concurrent opposite commands use serialized fresh group state; only first writes', async () => {
  let current = {0:'off',1:'off'};const paths=[];
  const g = new Gateway('localhost',80,async(h,p,path) => {
    paths.push(path);
    if (path.startsWith('/ctrl.xml?')) {
      const q = new URLSearchParams(path.split('?')[1]);
      const slot = Number(q.get('ac0')) === 1 ? 0 : 1;
      current[slot] = Object.keys(modes).find(k=>modes[k]===Number(q.get('mode')));
      return '';
    }
    return xml(current);
  },async()=>{});
  const [first,second] = await Promise.allSettled([g.change(0,{mode:'heat'},options),g.change(1,{mode:'cool'},options)]);
  assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');assert.match(second.reason.message,/conflict/);
  assert.equal(paths.filter(p=>p.startsWith('/ctrl.xml?')).length,1);
});
