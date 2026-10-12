'use strict';
const net = require('node:net');
const { probeGateway } = require('./metadata');
const MAX_ADDRESSES = 254;
const SEARCH_BUDGET_MS = 70000;
const MAC_STRATEGY = 'ccm15-mac';

function privateIPv4(host) {
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
const ipNumber = ip => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const numberIp = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');

function searchAddresses(cidr) {
  if (typeof cidr !== 'string') throw new Error('Enter a local IPv4 range, for example 192.168.1.0/24');
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || !privateIPv4(m[1])) throw new Error('Search requires a private local IPv4 network');
  const bits = Number(m[2]);
  if (bits < 24 || bits > 32) throw new Error('Search one local range at a time (/24 to /32)');
  const count = 2 ** (32 - bits), start = Math.floor(ipNumber(m[1]) / count) * count;
  const addresses = Array.from({ length: count }, (_, i) => numberIp(start + i));
  const usable = bits <= 30 ? addresses.slice(1, -1) : addresses;
  if (usable.length > MAX_ADDRESSES || !usable.every(privateIPv4)) throw new Error('Search range too large or not local');
  return usable;
}

function suggestedRange(address) {
  if (typeof address !== 'string') return '';
  let host;
  try { host = new URL(address.includes('://') ? address : `http://${address}`).hostname; } catch (_) { return ''; }
  return privateIPv4(host) ? `${host.split('.').slice(0, 3).join('.')}.0/24` : '';
}

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const parts = value.toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || !parts.every(part => /^[0-9a-f]{1,2}$/.test(part))) return null;
  const mac = parts.map(part => part.padStart(2, '0')).join(':');
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff' || parseInt(parts[0], 16) & 1) return null;
  return mac;
}

function matchingGateway(found, known) {
  const mac = normalizeMac(found.mac);
  const sameMac = mac && known.filter(item => normalizeMac(item.mac) === mac);
  const matches = sameMac?.length ? sameMac : known.filter(item => item.host === found.host && item.port === found.port);
  if (mac && !sameMac?.length && matches.some(item => normalizeMac(item.mac) && normalizeMac(item.mac) !== mac)) {
    throw new Error('A different network identifier is now using this saved IP; check the gateway identity');
  }
  const ids = new Set(matches.map(item => item.gatewayId).filter(Boolean));
  if (ids.size > 1) throw new Error('Multiple saved gateway identities match; use the existing gateway settings');
  return matches[0];
}

function identityFor(found, known, requested) {
  const match = matchingGateway(found, known);
  if (match) {
    if (requested && requested !== match.gatewayId) throw new Error(`Gateway already paired as ${match.gatewayId}; keep its identity`);
    return match.gatewayId;
  }
  if (requested) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(requested)) throw new Error('Use a stable gateway name');
    if (known.some(item => item.gatewayId === requested)) throw new Error('This identity belongs to another gateway');
    return requested;
  }
  const mac = normalizeMac(found.mac);
  if (mac) return `ccm15-${mac.replace(/:/g, '')}`;
  // No stable hardware identifier is exposed by HTTP. The UI allows an explicit
  // identity; retain this generated fallback if the gateway IP later changes.
  const { createHash } = require('node:crypto');
  return `ccm15-${createHash('sha256').update(`${found.host}:${found.port}`).digest('hex').slice(0, 12)}`;
}

async function searchGateways({ candidates = [], cidr = '', port = 80, scanAll = false,
  probe = probeGateway, getMac, signal, onProgress = () => {}, concurrency = 4,
  budget = SEARCH_BUDGET_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('Invalid search concurrency');
  const addresses = cidr ? searchAddresses(cidr) : [];
  const seen = new Set(), found = [], end = Date.now() + budget;
  const stats = { checked: 0, total: 0, phase: 'known', cancelled: false, timedOut: false };
  const stopped = () => signal?.aborted || Date.now() >= end;
  const notify = () => onProgress({ ...stats, found: found.map(item => ({ ...item })) });
  const workerBatch = async batch => {
    let next = 0;
    stats.total += batch.length;
    await notify();
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (next < batch.length && !stopped()) {
        const item = batch[next++], key = `${item.host}:${item.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const result = await probe(item.host, item.port, { signal, timeout: 800 });
          let mac = normalizeMac(item.mac);
          if (!mac && getMac) {
            // ARP is optional, and must not hold pairing open indefinitely.
            let timer;
            try { mac = normalizeMac(await Promise.race([Promise.resolve().then(() => getMac(item.host)),
              new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })])); }
            catch (_) {} finally { clearTimeout(timer); }
          }
          if (!stopped()) found.push({ ...result, mac, source: item.source || stats.phase });
        } catch (_) { /* A non-CCM15 host is an ordinary search miss. */ }
        stats.checked++;
        await notify();
      }
    }));
  };
  const unique = candidates.filter(item => privateIPv4(item.host) && Number.isInteger(item.port)
    && item.port > 0 && item.port <= 65535).filter((item, i, all) => all.findIndex(x => x.host === item.host && x.port === item.port) === i);
  await workerBatch(unique);
  if (!stopped() && (scanAll || !found.length) && addresses.length) {
    stats.phase = 'network';
    await workerBatch(addresses.map(host => ({ host, port, source: 'network' })).filter(item => !seen.has(`${item.host}:${item.port}`)));
  }
  stats.cancelled = signal?.aborted === true;
  stats.timedOut = !stats.cancelled && Date.now() >= end;
  stats.phase = 'done'; await notify();
  return { ...stats, found };
}

module.exports = { searchGateways, searchAddresses, suggestedRange, privateIPv4,
  normalizeMac, matchingGateway, identityFor, MAC_STRATEGY, MAX_ADDRESSES, SEARCH_BUDGET_MS };
