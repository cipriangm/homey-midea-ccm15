'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync(`${__dirname}/../drivers/indoor/pair/gateway.html`, 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

function view(respond) {
  let htmlWrites = 0, nextTimer = 0;
  const events = [], views = [], frameworkRenders = [], navigation = [], timers = new Map();
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.checked = true; this.disabled = false; }
    addEventListener(event, fn) { this.listeners[event] = fn; }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    set innerHTML(_) { htmlWrites++; throw new Error('Untrusted gateway information must be text'); }
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  elements['ccm15-pairing'].querySelector = selector => elements[selector.slice(1)] || null;
  elements.port.value = '80';
  const frameworkJquery = target => ({ html: value => { frameworkRenders.push({ target, value }); } });
  const context = vm.createContext({ document: { getElementById: id => elements[id] || null, createElement: () => new Element() },
    $: frameworkJquery, frameworkJquery, views,
    Homey: { setTitle: () => {}, setNavigationClose: () => navigation.push('close'), done: async () => navigation.push('done'),
      emit: async (event, data) => { events.push({ event, data }); return respond(event, data); } },
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), Map, Object, Number, String });
  // Navigation resolves $ in the same global environment as custom-view scripts.
  // A mock defined outside that environment concealed the v0.1.11 collision.
  vm.runInContext(`Homey.showView = async function(id) { const otherView = { id }; $(otherView).html('view'); views.push(id); };`, context);
  vm.runInContext(script, context);
  return { context, elements, events, views, timers, frameworkRenders, navigation, htmlWrites: () => htmlWrites };
}
const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('Pairing opens without scanning, renders configured names as text and waits for the user to choose a gateway', async () => {
  const result = { host: '192.168.50.10', port: 80, indoorCount: 1, slots: [0],
    metadata: { gateway: { name: '<img src=x onerror=alert(1)>' }, rooms: { names: { 0: '<script>room</script>', 7: 'Absent indoor' } } } };
  const ui = view(event => ({ discovery_context: { range: '192.168.50.0/24' }, start_search: { id: 'one' },
    search_status: { id: 'one', phase: 'done', found: [result] }, configure: 1,
    pairing_summary: { total: 1, alreadyPaired: 0, available: 1 }, cancel_search: true }[event]));
  await drain(); assert.deepEqual(ui.events.map(e => e.event), ['discovery_context']);
  assert.equal(ui.elements.range.value, '192.168.50.0/24');
  await ui.elements.find.listeners.click();
  assert.equal(ui.views.length, 0); assert.equal(ui.htmlWrites(), 0);
  const card = ui.elements.results.children[0];
  assert.match(card.children[0].textContent, /<img/); assert.equal(card.children[1].textContent, '<script>room</script>');
  await card.children[2].listeners.click();
  assert.deepEqual(ui.views, ['list_devices']);
  assert.equal(ui.frameworkRenders.length, 1);
  assert.equal(vm.runInContext('$ === frameworkJquery', ui.context), true);
  const configure = ui.events.find(e => e.event === 'configure').data;
  assert.equal(configure.host, '192.168.50.10'); assert.equal(configure.importNames, true); assert.equal(configure.gatewayId, '');
});
test('A partial gateway continues to native device selection while preserving Homey navigation globals', async () => {
  const ui = view(event => ({ discovery_context: { range: '' }, configure: 9, cancel_search: true,
    pairing_summary: { total: 9, alreadyPaired: 7, available: 2 } }[event]));
  await drain(); ui.elements.host.value = '192.168.50.10';
  ui.elements.gateway.listeners.submit({ preventDefault() {} }); await drain();
  assert.deepEqual(ui.views, ['list_devices']); assert.equal(ui.frameworkRenders.length, 1);
  assert.equal(ui.elements.finished.hidden, true); assert.deepEqual(ui.navigation, []);
});
test('A gateway whose indoors are already paired displays an explicit completion message and closes without adding anything', async () => {
  const ui = view(event => ({ discovery_context: { range: '' }, configure: 9, cancel_search: true,
    pairing_summary: { total: 9, alreadyPaired: 9, available: 0 } }[event]));
  await drain(); ui.elements.host.value = '192.168.50.10';
  ui.elements.gateway.listeners.submit({ preventDefault() {} }); await drain();
  assert.match(ui.elements.message.textContent, /All 9 indoor units .* already added/);
  assert.equal(ui.elements.finished.hidden, false); assert.deepEqual(ui.views, []);
  assert.deepEqual(ui.navigation, []);
  await ui.elements.finished.listeners.click(); assert.deepEqual(ui.navigation, ['done']);
  assert.ok(ui.events.every(e => !/create|add_device/.test(e.event)));
});
test('Reentering a custom pairing view keeps framework bindings and does not redeclare global variables', async () => {
  const ui = view(event => event === 'discovery_context' ? { range: '' } : true);
  await drain(); vm.runInContext(script, ui.context); await drain();
  assert.equal(vm.runInContext('$ === frameworkJquery', ui.context), true);
  assert.equal(ui.events.filter(event => event.event === 'discovery_context').length, 2);
});
test('Pairing search progress stays responsive, Stop cancels polling, and full-range mode is explicit', async () => {
  const ui = view(event => ({ discovery_context: { range: '192.168.50.0/24' }, start_search: { id: 'one' },
    search_status: { id: 'one', phase: 'network', checked: 5, total: 254, found: [] }, cancel_search: true }[event]));
  await drain(); await ui.elements.scan.listeners.click();
  assert.equal(ui.events.find(e => e.event === 'start_search').data.scanAll, true);
  assert.match(ui.elements.message.textContent, /5\/254/); assert.equal(ui.elements.cancel.hidden, false); assert.equal(ui.timers.size, 1);
  await ui.elements.cancel.listeners.click();
  assert.equal(ui.timers.size, 0); assert.equal(ui.elements.find.disabled, false); assert.equal(ui.elements.cancel.hidden, true);
  assert.equal(ui.elements.message.textContent, 'Search stopped.');
});
test('Manual pairing remains available, honors the name-import choice and displays failures without navigating', async () => {
  const ui = view(event => { if (event === 'configure') throw new Error('No indoor units found'); return event === 'discovery_context' ? { range: '' } : true; });
  await drain(); ui.elements.host.value = '192.168.50.10'; ui.elements.names.checked = false; ui.elements.identity.value = 'my-gateway';
  ui.elements.gateway.listeners.submit({ preventDefault() {} }); await drain();
  assert.equal(ui.events.find(e => e.event === 'configure').data.importNames, false);
  assert.equal(ui.events.find(e => e.event === 'configure').data.gatewayId, 'my-gateway');
  assert.equal(ui.elements.message.textContent, 'No indoor units found'); assert.equal(ui.elements.discover.disabled, false); assert.equal(ui.views.length, 0);
});
