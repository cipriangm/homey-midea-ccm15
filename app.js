'use strict';
const Homey = require('homey');
const { Gateway } = require('./lib/gateway');
const { readMetadata, metadataLabels } = require('./lib/metadata');
const { normalizeMac } = require('./lib/discovery');

module.exports = class CCM15App extends Homey.App {
  async onInit() {
    this.gateways = new Map(); this.polling = false; this.stopping = false;
    this.timer = this.homey.setInterval(() => this.pollAll().catch(this.error), 15000);
    const actions = { set_mode: ({ device, mode }) => device.change({ mode }),
      set_fan: ({ device, fan }) => device.change({ fan }),
      set_temperature: ({ device, temperature }) => device.change({ target: temperature }),
      set_climate: ({ device, mode, fan, temperature }) => device.change({ mode, fan, target: temperature }),
      set_power: ({ device, power }) => device.setPower(switchValue(power)),
      set_swing: ({ device, state }) => device.change({ swing: switchValue(state) }),
      set_heater: ({ device, state }) => device.change({ heater: switchValue(state) }),
      set_mode_lock: ({ device, value }) => device.setLock('mode', value),
      set_fan_lock: ({ device, value }) => device.setLock('fan', value),
      set_cooling_limit: ({ device, temperature }) => device.setLock('coolLimit', temperature),
      set_heating_limit: ({ device, temperature }) => device.setLock('heatLimit', temperature),
      clear_temperature_limit: ({ device, kind }) => {
        if (!['coolLimit', 'heatLimit'].includes(kind)) throw new Error('Choose the cooling or heating temperature limit');
        return device.setLock(kind, null);
      },
      set_remote_lock: ({ device, state }) => device.setLock('remote', switchValue(state)),
      refresh_status: ({ device }) => device.refresh() };
    for (const [id, fn] of Object.entries(actions)) this.homey.flow.getActionCard(id).registerRunListener(fn);
    this.homey.flow.getConditionCard('is_connected').registerRunListener(({ device }) => device.getCapabilityValue('ccm15_connected') === true);
    for (const [id, cap] of Object.entries({ is_mode: 'ccm15_mode', is_fan: 'ccm15_fan' })) {
      this.homey.flow.getConditionCard(id).registerRunListener(({ device, value }) => device.getCapabilityValue('ccm15_connected') === true && (typeof device.getReportedCapabilityValue === 'function' ? device.getReportedCapabilityValue(cap) : device.getCapabilityValue(cap)) === value);
    }
    this.homey.flow.getConditionCard('has_fault').registerRunListener(({ device }) => {
      const value = device.getCapabilityValue('ccm15_error');
      return device.getCapabilityValue('ccm15_connected') === true && Number.isInteger(value) && value > 0;
    });
    this.homey.flow.getConditionCard('temperature_above').registerRunListener(({ device, temperature }) => {
      const measured = device.getCapabilityValue('measure_temperature');
      return device.getCapabilityValue('ccm15_connected') === true && Number.isFinite(measured) && Number.isFinite(temperature) && measured > temperature;
    });
    this.homey.flow.getConditionCard('is_locked').registerRunListener(({ device, kind }) => {
      if (device.getCapabilityValue('ccm15_connected') !== true) return false;
      const value = device.getCapabilityValue({ mode: 'ccm15_mode_locked', fan: 'ccm15_fan_locked', remote: 'ccm15_remote_locked', coolLimit: 'ccm15_cool_limit', heatLimit: 'ccm15_heat_limit' }[kind]);
      return ['coolLimit', 'heatLimit'].includes(kind) ? typeof value === 'number' : value === true;
    });
  }
  async recordCommand(device, diagnostic) {
    const detail = diagnostic.detail || (diagnostic.status === 'queued' ? 'Command queued; execution and state confirmation are pending'
      : diagnostic.status === 'confirmed' ? `State confirmed after ${diagnostic.observations.length} read(s)${diagnostic.offSwingStopped ? '; swing stopped with power Off' : ''}${diagnostic.offFanStopped ? '; fan reported stopped with power Off' : ''}`
      : diagnostic.writes ? `Sent once; waiting for gateway state (${diagnostic.observations.length} read(s))`
      : 'Reading current state before control');
    // A completed older request must not replace the status of a newer queued one.
    if (!diagnostic.commandId || device.latestCommandId === diagnostic.commandId) {
      device.unconfirmedCommand = diagnostic.status === 'unconfirmed' && diagnostic.writes === 1 && diagnostic.expected
        ? { diagnostic, expiresAt: Date.now() + 60000, generation: device.generation } : null;
      await Promise.allSettled([
        device.setCapabilityValue('ccm15_command_status', diagnostic.status),
        device.setCapabilityValue('ccm15_command_detail', detail),
      ]);
      if (['unconfirmed', 'rejected', 'fault'].includes(diagnostic.status)) {
        await device.setWarning(detail).catch(this.error); device.commandWarning = true;
      } else if (device.commandWarning) {
        await device.unsetWarning().catch(this.error); device.commandWarning = false;
      }
    }
    if (['selecting', 'queued', 'pending'].includes(diagnostic.status)) return;
    // Local-only, bounded history. Contains no HTTP URL, password or credential.
    const previous = this.homey.settings.get('command_diagnostics');
    this.homey.settings.set('command_diagnostics', [...(Array.isArray(previous) ? previous : []), { deviceId: device.getData().id, gateway: device.gatewayKey, ...diagnostic }].slice(-20));
    // Do not await a Flow that may itself enqueue a command on this gateway.
    this.homey.flow.getDeviceTriggerCard('command_result').trigger(device, {
      status: diagnostic.status, detail, seconds: diagnostic.durationMs / 1000,
      command_id: diagnostic.commandId || '', kind: diagnostic.kind, slot: diagnostic.slot,
    }).catch(this.error);
  }
  attach(device, settings = device.getSettings()) {
    const { host, port } = settings;
    const key = `${host}:${port}`;
    if (!this.gateways.has(key)) this.gateways.set(key, { client: new Gateway(host, port), devices: new Set() });
    const entry = this.gateways.get(key); entry.devices.add(device); device.gatewayKey = key;
    return entry.client;
  }
  detach(device) {
    const entry = this.gateways.get(device.gatewayKey);
    if (entry) { entry.devices.delete(device); if (!entry.devices.size) this.gateways.delete(device.gatewayKey); }
  }
  async deliver(entry, states, error) {
    const results = await Promise.allSettled([...entry.devices].map(d => d.updateState(states?.get(d.getData().slot), error)));
    for (const result of results) if (result.status === 'rejected') this.error('Device state update failed', result.reason);
  }
  async refresh(client) {
    const entry = this.gateways.get(`${client.host}:${client.port}`);
    try { const states = await client.poll(); if (entry) await this.deliver(entry, states); return true; }
    catch (error) { if (entry) await this.deliver(entry, null, error); throw error; }
  }
  readGatewayMetadata(host, port) { return readMetadata(host, port); }
  async refreshGatewayMetadata(client) {
    const entry = this.gateways.get(`${client.host}:${client.port}`);
    if (!entry) return;
    if (entry.metadataPromise && Date.now() >= entry.metadataExpiresAt) {
      entry.metadataPromise = null; entry.metadataDevices = new WeakSet();
    }
    if (!entry.metadataPromise) {
      entry.metadataExpiresAt = Infinity;
      entry.metadataPromise = client.enqueue(async () => {
      const metadata = await this.readGatewayMetadata(client.host, client.port);
      // ARP is useful for identity, but optional across routed networks.
      let mac;
      let timer;
      try { mac = normalizeMac(await Promise.race([this.homey.arp.getMAC(client.host),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })])); }
      catch (_) {} finally { clearTimeout(timer); }
        entry.metadataExpiresAt = Date.now() + (metadata.gateway && metadata.rooms ? 600000 : 60000);
        return { metadata, mac };
      }).catch(error => { entry.metadataExpiresAt = Date.now() + 60000; throw error; });
    }
    const { metadata, mac } = await entry.metadataPromise;
    // Serialize application of the shared snapshot: simultaneous indoor init
    // must not generate nine copies of each settings/store update.
    entry.metadataDelivery = (entry.metadataDelivery || Promise.resolve()).catch(() => {}).then(async () => {
      entry.metadataDevices ||= new WeakSet();
      for (const device of entry.devices) {
        if (device.stopped || device.client !== client || entry.metadataDevices.has(device)) continue;
        const previous = device.getStoreValue('gateway_metadata');
        const effective = { gateway: metadata.gateway || previous?.gateway || null,
          rooms: metadata.rooms || previous?.rooms || null, readAt: metadata.readAt };
        const effectiveMac = mac || normalizeMac(device.getStoreValue('gateway_mac'));
        if (mac && device.getStoreValue('gateway_mac') !== mac) await device.setStoreValue('gateway_mac', mac);
        if (metadata.gateway || metadata.rooms) await device.setStoreValue('gateway_metadata', effective);
        const labels = metadataLabels(effective, device.getData().slot, effectiveMac);
        const changed = Object.fromEntries(Object.entries(labels).filter(([key, value]) => device.getSetting(key) !== value));
        if (Object.keys(changed).length) await device.setSettings(changed);
        entry.metadataDevices.add(device);
      }
    });
    return entry.metadataDelivery;
  }
  async pollAll() {
    if (this.polling) return;
    this.polling = true;
    try { for (const entry of this.gateways.values()) {
      await this.refresh(entry.client).catch(() => {});
      await this.refreshGatewayMetadata(entry.client).catch(this.error);
    } }
    finally { this.polling = false; }
  }
  async onUninit() {
    this.stopping = true; this.homey.clearInterval(this.timer);
    for (const entry of this.gateways.values()) for (const device of entry.devices) device.uiChanges?.cancel();
  }
};

function switchValue(value) {
  if (!['on', 'off'].includes(value)) throw new Error('Choose On or Off');
  return value === 'on';
}
