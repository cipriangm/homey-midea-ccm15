'use strict';
const http = require('node:http');
const net = require('node:net');
const { gunzipSync } = require('node:zlib');
const { validateAddress } = require('./gateway');
const { parseStatus } = require('./protocol');
const READ_PATHS = new Set(['/status.xml', '/setting.xml', '/roomset.xml']);
const MAX_XML_BYTES = 65536;

function decodeXml(buffer, encoding) {
  if (encoding === 'gzip') buffer = gunzipSync(buffer, { maxOutputLength: MAX_XML_BYTES });
  else if (encoding && encoding !== 'identity') throw new Error('Unsupported XML encoding');
  if (buffer.length > MAX_XML_BYTES) throw new Error('XML response too large');
  const declaration = /encoding\s*=\s*["']([^"']+)["']/i.exec(buffer.subarray(0, 200).toString('ascii'));
  const charset = declaration?.[1] || 'utf-8';
  // This firmware declares GB2312. Never silently corrupt configured labels.
  return new TextDecoder(charset, { fatal: true }).decode(buffer);
}

function readOnlyRequest(host, port, path, { timeout = 1500, signal } = {}) {
  validateAddress(host, port);
  // setting.xml and roomset.xml also have write operations. Reads have NO query.
  if (!READ_PATHS.has(path)) return Promise.reject(new Error('Read-only discovery endpoint required'));
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port, path, signal, agent: false,
      headers: { 'Accept-Encoding': 'identity' } }, res => {
      if (res.statusCode !== 200) {
        res.resume(); reject(new Error(`Gateway read returned HTTP ${res.statusCode}`)); return;
      }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_XML_BYTES) req.destroy(new Error('XML response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(decodeXml(Buffer.concat(chunks), res.headers['content-encoding'])); }
        catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Gateway read timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

function xmlText(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(value)) throw new Error('Invalid XML entity');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Error('Invalid XML character');
    return String.fromCodePoint(code);
  });
}

function flatXml(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_XML_BYTES || /<!|<\?(?!xml\s)/i.test(xml)) throw new Error('Invalid metadata XML');
  const body = xml.trim().replace(/^<\?xml\s[^?]*\?>\s*/i, '');
  const root = /^<response>\s*([\s\S]*?)\s*<\/response>$/.exec(body);
  if (!root) throw new Error('Missing metadata response root');
  const fields = new Map();
  const remainder = root[1].replace(/<([A-Za-z][\w]*)>\s*([^<]*)<\/\1>/g, (_, key, value) => {
    if (fields.has(key)) throw new Error('Duplicate metadata field');
    fields.set(key, xmlText(value)); return '';
  });
  if (remainder.trim() || !fields.size) throw new Error('Malformed metadata XML');
  return fields;
}

const cleanLabel = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240) : '';

function parseSettings(xml) {
  const f = flatXml(xml);
  if (!f.has('name') || !/^[01]$/.test(f.get('dhcp')?.trim() || '')
    || !/^\d+$/.test(f.get('ccm03')?.trim() || '')
    || !['ip', 'netmask', 'gateway'].every(k => net.isIPv4(f.get(k)?.trim() || ''))) throw new Error('Unrecognized CCM15 settings');
  // Whitelist only. The same response can contain a password and cloud account ID.
  // Neither is returned, logged, imported, or automatically used for control.
  return { name: cleanLabel(f.get('name')), ip: f.get('ip').trim(),
    netmask: f.get('netmask').trim(), router: f.get('gateway').trim(), dhcp: f.get('dhcp').trim() === '1' };
}

function parseRoomset(xml) {
  const f = flatXml(xml);
  for (let i = 0; i < 16; i++) if (!f.has(`rs${i}`)) throw new Error('Incomplete CCM15 room settings');
  // Verified in midea.js get_roomset_ret/toLocalRoomSet: 15 triples (name,
  // low/high unsigned address masks), then 64 indoor names. These are DISPLAY
  // groups, not refrigerant circuits or automatically detected model types.
  const parts = Array.from({ length: 16 }, (_, i) => f.get(`rs${i}`)).join('').split(',');
  if (parts.length < 45 || parts.length > 120) throw new Error('Invalid CCM15 room settings');
  const areas = [];
  for (let i = 0; i < 15; i++) {
    const name = cleanLabel(parts[i * 3]);
    const masks = [parts[i * 3 + 1], parts[i * 3 + 2]].map(value => {
      if (value === '') return 0;
      if (!/^\d{1,10}$/.test(value) || Number(value) > 0xffffffff) throw new Error('Invalid area address mask');
      return Number(value);
    });
    if (name) areas.push({ id: i + 1, name, slots: Array.from({ length: 64 }, (_, slot) => slot)
      .filter(slot => !!((masks[slot < 32 ? 0 : 1] >>> (slot % 32)) & 1)) });
  }
  const names = {};
  for (let slot = 0; slot < 64; slot++) {
    const name = cleanLabel(parts[45 + slot]);
    if (name && name !== `AC-${slot}`) names[slot] = name;
  }
  return { names, areas };
}

async function readMetadata(host, port = 80, { transport = readOnlyRequest, timeout = 1500, signal } = {}) {
  const results = await Promise.allSettled([
    transport(host, port, '/setting.xml', { timeout, signal }).then(parseSettings),
    transport(host, port, '/roomset.xml', { timeout, signal }).then(parseRoomset),
  ]);
  return { gateway: results[0].status === 'fulfilled' ? results[0].value : null,
    rooms: results[1].status === 'fulfilled' ? results[1].value : null, readAt: new Date().toISOString() };
}

async function probeGateway(host, port = 80, { transport = readOnlyRequest, timeout = 800, signal } = {}) {
  const xml = await transport(host, port, '/status.xml', { timeout, signal });
  const states = parseStatus(xml);
  const metadata = await readMetadata(host, port, { transport, timeout: Math.max(timeout, 1500), signal });
  if (!metadata.gateway && !metadata.rooms) throw new Error('Status found, but CCM15 identity was not verified');
  return { host, port, slots: [...states.keys()], indoorCount: states.size, metadata };
}

function metadataLabels(metadata, slot, mac) {
  const gateway = metadata?.gateway, rooms = metadata?.rooms;
  const network = gateway ? `${gateway.dhcp ? 'DHCP' : 'Static IP'} · ${gateway.ip} · ${gateway.netmask} · router ${gateway.router}` : 'Not reported';
  return { gateway_reported_name: gateway?.name || 'Not reported',
    gateway_network_info: network, gateway_mac_info: mac || 'Not reported',
    gateway_indoor_name: rooms?.names[slot] || 'Not configured in gateway',
    gateway_areas: rooms?.areas.filter(area => area.slots.includes(slot)).map(area => area.name).join(', ') || 'No configured display group' };
}

module.exports = { readOnlyRequest, decodeXml, flatXml, parseSettings, parseRoomset,
  readMetadata, probeGateway, metadataLabels, cleanLabel, MAX_XML_BYTES };
