'use strict';
const Homey = require('homey');
const { randomUUID } = require('node:crypto');
const { Gateway } = require('../../lib/gateway');
const { readMetadata, metadataLabels, probeGateway } = require('../../lib/metadata');
const { searchGateways, searchAddresses, suggestedRange, normalizeMac, identityFor, MAC_STRATEGY } = require('../../lib/discovery');

async function bounded(fn, fallback, milliseconds = 2000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })]); }
  catch (_) { return fallback; } finally { clearTimeout(timer); }
}

module.exports = class IndoorDriver extends Homey.Driver {
  metadataFor(host, port) { return readMetadata(host, port); }
  probe(host, port, options) { return probeGateway(host, port, options); }
  knownGateways() {
    const devices = typeof this.getDevices === 'function' ? this.getDevices() : [];
    return devices.map(device => {
      const data = device.getData(), settings = device.getSettings();
      return { host: settings.host, port: Number(settings.port),
        gatewayId: data.gatewayId || data.id?.replace(/:a\d+$/, ''),
        mac: device.getStoreValue('gateway_mac') || null };
    });
  }
  async discoveryCandidates(port) {
    const known = this.knownGateways().map(item => ({ ...item, source: 'saved' }));
    const native = await bounded(async () => {
      const strategy = this.homey.discovery.getStrategy(MAC_STRATEGY);
      return Object.values(strategy.getDiscoveryResults()).map(result => ({ host: result.address,
        port, mac: normalizeMac(result.id), source: 'mac' }));
    }, []);
    return [...known, ...native];
  }
  async onPair(session) {
    let config, job;
    const cancel = () => { job?.controller.abort(); };
    session.setHandler('disconnect', async () => { cancel(); });
    session.setHandler('cancel_search', async () => { cancel(); return true; });
    session.setHandler('discovery_candidates', async (data = {}) => {
      const port = Number(data.port ?? 80);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port');
      return this.discoveryCandidates(port);
    });
    session.setHandler('discovery_context', async () => {
      const known = this.knownGateways();
      const address = await bounded(() => this.homey.cloud.getLocalAddress(), '');
      return { range: suggestedRange(known[0]?.host) || suggestedRange(address), knownGateways: new Set(known.map(k => k.gatewayId)).size };
    });
    session.setHandler('start_search', async (data = {}) => {
      const port = Number(data.port ?? 80), cidr = (data.cidr || '').trim();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port');
      if (data.scanAll === true && !cidr) throw new Error('Enter a local network range before a full search');
      if (cidr) searchAddresses(cidr);
      cancel();
      const current = { id: randomUUID(), controller: new AbortController(),
        progress: { phase: 'starting', checked: 0, total: 0, found: [] } };
      job = current;
      // The event acknowledges immediately; a Homey callback has a short timeout.
      // Progress is fetched separately, and closing/selecting cancels the reads.
      current.task = (async () => {
        const candidates = data.scanAll === true ? [] : await this.discoveryCandidates(port);
        current.progress = await searchGateways({ candidates, cidr, port, scanAll: data.scanAll === true,
          probe: (host, targetPort, options) => this.probe(host, targetPort, options),
          signal: current.controller.signal, getMac: host => this.homey.arp.getMAC(host),
          onProgress: progress => { current.progress = progress; } });
      })().catch(error => { current.progress = { ...current.progress, phase: 'done', error: error.message }; });
      return { id: current.id };
    });
    session.setHandler('search_status', async () => job ? { id: job.id, ...job.progress } : { phase: 'idle', found: [] });
    session.setHandler('configure', async data => {
      cancel();
      const requested = data.gatewayId?.trim() || '';
      if (requested && !/^[a-zA-Z0-9_-]{1,64}$/.test(requested)) throw new Error('Use a stable gateway name');
      const gateway = new Gateway(data.host, Number(data.port));
      const states = await gateway.poll();
      if (!states.size) throw new Error('No indoor units found');
      const metadata = await this.metadataFor(data.host, Number(data.port));
      const mac = normalizeMac(await bounded(() => this.homey.arp.getMAC(data.host), null, 1000));
      const gatewayId = identityFor({ host: data.host, port: Number(data.port), mac }, this.knownGateways(), requested);
      config = { host: data.host, port: Number(data.port), gatewayId, metadata, mac, importNames: data.importNames !== false };
      return states.size;
    });
    session.setHandler('gateway_details', async () => {
      if (!config) throw new Error('Configure the gateway first');
      return { gatewayId: config.gatewayId, mac: config.mac, metadata: config.metadata };
    });
    const list = async () => {
      if (!config) throw new Error('Configure the gateway first');
      const states = await new Gateway(config.host, config.port).poll();
      return [...states.values()].map(state => ({ name: config.importNames && config.metadata.rooms?.names[state.slot]
        ? config.metadata.rooms.names[state.slot] : `Midea a${state.slot}`,
        data: { id: `${config.gatewayId}:a${state.slot}`, slot: state.slot, gatewayId: config.gatewayId },
        settings: { host: config.host, port: config.port, enable_control: false,
          extras_policy: 'blocked', password: '', start_mode: 'cool', indoor_type: 'unknown',
          heater_supported: false, vrf_policy: 'none', vrf_group_slots: '', ...metadataLabels(config.metadata, state.slot, config.mac) },
        store: { gateway_mac: config.mac || '', gateway_metadata: config.metadata } }));
    };
    session.setHandler('list_devices', list);
    session.setHandler('pairing_summary', async () => {
      const proposed = await list();
      const paired = new Set(this.getDevices().map(device => device.getData().id));
      const alreadyPaired = proposed.filter(device => paired.has(device.data.id)).length;
      return { total: proposed.length, alreadyPaired, available: proposed.length - alreadyPaired };
    });
    // Also used by read-only QA: inspect proposed devices without creating any.
    session.setHandler('preview_devices', list);
  }
};
