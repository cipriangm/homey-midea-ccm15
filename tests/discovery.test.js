'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const { readOnlyRequest, decodeXml, parseSettings, parseRoomset, readMetadata, probeGateway } = require('../lib/metadata');
const { searchGateways, searchAddresses, suggestedRange, normalizeMac, identityFor } = require('../lib/discovery');
const status = '<response><a0>00000010d0001a,</a0><a7>-</a7><a32>00000010d0001a,</a32></response>';
const settings = '<response><name>CCM15 test</name><ccm03>0</ccm03><dhcp>1</dhcp><ip>192.168.50.10</ip><netmask>255.255.255.0</netmask><gateway>192.168.50.1</gateway><port>3562</port><pwd>never-import-this</pwd><cloudid>private-account</cloudid><cloudip>private-cloud</cloudip></response>';
function roomsXml() {
  const parts = Array(109).fill('');
  parts[0] = 'Upstairs'; parts[1] = String(2 ** 31 + 1); parts[2] = String(2 ** 31 + 1);
  parts[45] = 'Camera &amp; birou'; parts[45 + 7] = 'AC-7'; parts[45 + 32] = '房间'; parts[45 + 63] = '&lt;script&gt;';
  const text = parts.join(',');
  const chunks = Array.from({ length: 16 }, (_, i) => text.slice(i * 64, (i + 1) * 64));
  return '<response>' + chunks.map((chunk, i) => `<rs${i}>${chunk}</rs${i}>`).join('') + '</response>';
}
async function serverFixture(fn, callback) {
  const calls = [], server = http.createServer((req, res) => { calls.push(req.url); fn(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await callback(server.address().port, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Metadata imports only safe fields, not gateway passwords, cloud identities or the non-HTTP port', () => {
  const parsed = parseSettings(settings);
  assert.deepEqual(parsed, { name: 'CCM15 test', ip: '192.168.50.10', netmask: '255.255.255.0', router: '192.168.50.1', dhcp: true });
  assert.ok(!/never-import|private-account|private-cloud|3562/.test(JSON.stringify(parsed)));
});
test('Gateway room names and display groups retain true slots on both 32-bit masks', () => {
  const parsed = parseRoomset(roomsXml());
  assert.deepEqual(parsed.areas[0].slots, [0, 31, 32, 63]);
  assert.equal(parsed.names[0], 'Camera & birou'); assert.equal(parsed.names[32], '房间');
  assert.equal(parsed.names[63], '<script>'); assert.equal(parsed.names[7], undefined);
  assert.ok(!Object.hasOwn(parsed, 'indoorType')); assert.ok(!Object.hasOwn(parsed, 'vrfGroup'));
});
test('Metadata refuses malformed XML, entities, duplicate fields and invalid unsigned group masks', () => {
  for (const xml of ['<html>not a gateway</html>', '<!DOCTYPE response><response></response>',
    settings.replace('</name>', '&undefined;</name>'), settings.replace('</response>', '<name>duplicate</name></response>'),
    settings.replace('192.168.50.10', 'https://example.com')]) assert.throws(() => parseSettings(xml));
  assert.throws(() => parseRoomset(roomsXml().replace(String(2 ** 31 + 1), '-1')));
  assert.throws(() => parseRoomset('<response><rs0>partial</rs0></response>'));
});
test('The XML decoder handles real GB2312 and bounds gzip expansion', () => {
  const chinese = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="gb2312"?><response><name>'), Buffer.from([0xb7, 0xbf, 0xbc, 0xe4]), Buffer.from('</name></response>')]);
  assert.match(decodeXml(chinese), /房间/);
  assert.equal(decodeXml(gzipSync(Buffer.from(settings)), 'gzip'), settings);
  assert.throws(() => decodeXml(gzipSync(Buffer.alloc(70000)), 'gzip'));
  assert.throws(() => decodeXml(Buffer.from('x'), 'br'));
});
test('Discovery transport permits only three query-free read endpoints and never follows redirects', async () => {
  await serverFixture((req, res) => { res.writeHead(302, { Location: '/ctrl.xml?mode=0' }); res.end('redirect'); }, async (port, calls) => {
    for (const path of ['/ctrl.xml', '/setting.xml?dhcp=0', '/roomset.xml?a=0&d=changed']) await assert.rejects(readOnlyRequest('127.0.0.1', port, path), /Read-only/);
    assert.equal(calls.length, 0);
    await assert.rejects(readOnlyRequest('127.0.0.1', port, '/status.xml'), /HTTP 302/);
    assert.deepEqual(calls, ['/status.xml']);
  });
});
test('Oversized HTTP responses, cancellation and unresponsive hosts terminate bounded reads', async () => {
  await serverFixture((req, res) => res.end('x'.repeat(70000)), async port => {
    await assert.rejects(readOnlyRequest('127.0.0.1', port, '/status.xml'), /too large/);
  });
  await serverFixture(() => {}, async port => {
    await assert.rejects(readOnlyRequest('127.0.0.1', port, '/status.xml', { timeout: 25 }), /timeout/);
    const controller = new AbortController();
    const result = readOnlyRequest('127.0.0.1', port, '/status.xml', { signal: controller.signal });
    controller.abort(); await assert.rejects(result, /abort/i);
  });
});
test('A gateway needs valid indoor status and a CCM15 metadata fingerprint; XML filenames alone do not identify it', async () => {
  const calls = [];
  const transport = async (_, __, path) => { calls.push(path); return { '/status.xml': status, '/setting.xml': settings, '/roomset.xml': roomsXml() }[path]; };
  const result = await probeGateway('192.168.50.10', 80, { transport });
  assert.deepEqual(result.slots, [0, 32]); assert.equal(result.indoorCount, 2);
  assert.deepEqual(calls.sort(), ['/roomset.xml', '/setting.xml', '/status.xml']);
  assert.ok(!JSON.stringify(result).includes('never-import-this'));
  await assert.rejects(probeGateway('192.168.50.11', 80, { transport: async (_, __, path) => path === '/status.xml' ? status : '<response><value>1</value></response>' }), /identity/);
  await assert.rejects(probeGateway('192.168.50.11', 80, { transport: async () => '<html>status.xml exists</html>' }), /response/);
});
test('Optional metadata failure does not break monitoring or import incomplete configuration', async () => {
  const result = await readMetadata('192.168.50.10', 80, { transport: async (_, __, path) => {
    if (path === '/setting.xml') throw new Error('metadata unavailable'); return roomsXml();
  } });
  assert.equal(result.gateway, null); assert.equal(result.rooms.names[32], '房间');
});
test('Network search is limited to explicit private IPv4 blocks, without broadcast or network addresses', () => {
  assert.equal(searchAddresses('192.168.50.99/24').length, 254);
  assert.deepEqual(searchAddresses('172.16.1.19/30'), ['172.16.1.17', '172.16.1.18']);
  assert.deepEqual(searchAddresses('10.0.0.4/32'), ['10.0.0.4']);
  for (const range of ['192.168.50.0/16', '8.8.8.0/24', '127.0.0.0/24', '169.254.1.0/24', '224.0.0.0/24', '10.0.0.0/33', 'http://192.168.50.1/24']) assert.throws(() => searchAddresses(range));
  assert.equal(suggestedRange('http://192.168.50.3:80'), '192.168.50.0/24');
  assert.equal(suggestedRange('192.168.50.3:80'), '192.168.50.0/24'); assert.equal(suggestedRange('8.8.8.8'), '');
});
test('Verified saved/MAC candidates avoid an unnecessary subnet scan and are deduplicated', async () => {
  const calls = [], progress = [];
  const result = await searchGateways({ candidates: [
    { host: '192.168.50.10', port: 80, source: 'saved' }, { host: '192.168.50.10', port: 80, source: 'mac' },
    { host: '8.8.8.8', port: 80 }], cidr: '192.168.50.0/24',
    probe: async (host, port) => { calls.push(host); return { host, port, indoorCount: 2 }; },
    getMac: async () => '0:4:a3:aa:bb:cc', onProgress: state => { progress.push(state); } });
  assert.deepEqual(calls, ['192.168.50.10']); assert.equal(result.found[0].mac, '00:04:a3:aa:bb:cc');
  assert.equal(result.found[0].source, 'saved'); assert.equal(progress.at(-1).phase, 'done');
});
test('Fallback and full-range scans use bounded concurrency and return only verified gateways', async () => {
  let active = 0, maxActive = 0;
  const calls = [];
  const result = await searchGateways({ cidr: '192.168.50.8/29', concurrency: 2,
    probe: async (host, port) => {
      active++; maxActive = Math.max(maxActive, active); calls.push(host);
      await new Promise(resolve => setTimeout(resolve, 2)); active--;
      if (!host.endsWith('.10')) throw new Error('not CCM15'); return { host, port, indoorCount: 2 };
    } });
  assert.equal(maxActive, 2); assert.equal(calls.length, 6); assert.equal(result.checked, 6);
  assert.equal(result.found.length, 1); assert.equal(result.found[0].source, 'network');
  let count = 0;
  await searchGateways({ candidates: [{ host: '192.168.50.10', port: 80 }], cidr: '192.168.50.8/29', scanAll: true,
    probe: async (host, port) => { count++; return { host, port }; } });
  assert.equal(count, 6);
});
test('Cancelling a search stops in-flight requests and prevents further addresses being contacted', async () => {
  const controller = new AbortController(); let attempts = 0;
  const run = searchGateways({ cidr: '192.168.50.0/24', signal: controller.signal, concurrency: 2,
    probe: async (_, __, { signal }) => {
      attempts++;
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } });
  setTimeout(() => controller.abort(), 5);
  const result = await run;
  assert.equal(attempts, 2); assert.equal(result.cancelled, true); assert.deepEqual(result.found, []);
});
test('Gateway identity follows a verified MAC and reuses existing devices; conflicting identities are refused', () => {
  const known = [{ host: '192.168.50.10', port: 80, gatewayId: 'existing', mac: '00:04:a3:aa:bb:cc' }];
  assert.equal(identityFor({ host: '192.168.50.10', port: 80 }, known), 'existing');
  assert.equal(identityFor({ host: '192.168.50.20', port: 80, mac: '0:4:a3:aa:bb:cc' }, known), 'existing');
  assert.throws(() => identityFor({ host: '192.168.50.10', port: 80, mac: '00:04:a3:11:22:33' }, known), /different network identifier/);
  assert.throws(() => identityFor({ host: '192.168.50.10', port: 80 }, known, 'different'), /already paired/);
  assert.throws(() => identityFor({ host: '192.168.50.21', port: 80 }, known, 'existing'), /another gateway/);
  assert.equal(identityFor({ host: '192.168.50.21', port: 80, mac: '00:04:a3:11:22:33' }, known), 'ccm15-0004a3112233');
  assert.throws(() => identityFor({ host: '192.168.50.21', port: 80 }, [], '../bad'), /stable gateway/);
  assert.equal(normalizeMac('ff:ff:ff:ff:ff:ff'), null); assert.equal(normalizeMac('01:04:a3:11:22:33'), null);
});

module.exports = { roomsXml, settings };
