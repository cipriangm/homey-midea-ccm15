'use strict';
const Homey = require('homey');
const { randomUUID } = require('node:crypto');
const { validateAddress, snapshot, differences } = require('../../lib/gateway');
const { validatePatch, lockParameter } = require('../../lib/protocol');
const { parseGroupSlots } = require('../../lib/vrf');
const { UiChanges } = require('../../lib/ui-changes');
const { restrictionStatus, controlState, controlChoices } = require('../../lib/presentation');
const manifest = require('../../app.json');
const CLIMATE_CAPS = { target_temperature: 'target', ccm15_mode: 'mode', thermostat_mode: 'mode', ccm15_fan: 'fan', ccm15_swing: 'swing', ccm15_heater: 'heater' };
const LOCK_CAPS = { ccm15_mode_restriction: 'mode', ccm15_fan_restriction: 'fan', ccm15_cooling_limit_control: 'coolLimit', ccm15_heating_limit_control: 'heatLimit', ccm15_remote_lock_control: 'remote' };
const EDITABLE_CAPS = new Set(['onoff', ...Object.keys(CLIMATE_CAPS), ...Object.keys(LOCK_CAPS)]);
const REPORTED_CAPS = { onoff: 'ccm15_reported_power', target_temperature: 'ccm15_reported_target', ccm15_mode: 'ccm15_reported_mode', thermostat_mode: 'ccm15_reported_mode', ccm15_fan: 'ccm15_reported_fan' };
module.exports = class IndoorDevice extends Homey.Device {
  async onInit() {
    this.stopped = false; this.generation = (this.generation ?? 0) + 1;
    this.unconfirmedCommand = null;
    this.controlTasks = new Set();
    this.uiChanges = new UiChanges({
      setTimer: (fn, delay) => this.homey.setTimeout(fn, delay), clearTimer: timer => this.homey.clearTimeout(timer),
      dispatch: draft => this.dispatchUiChange(draft), error: error => this.error(error.message),
      settled: async () => {
        if (!this.stopped && !this.homey.app.stopping && !this.uiChanges.isHolding() && this.reportedState) await this.updateState(this.reportedState);
      },
    });
    await this.applyCapabilityProfile(this.getSettings());
    if (this.getCapabilityValue('ccm15_command_status') === 'selecting') {
      await this.setCapabilityValue('ccm15_command_detail', 'Uncommitted selection cleared at restart; no command sent');
      await this.setCapabilityValue('ccm15_command_status', 'none');
    } else if (this.getCapabilityValue('ccm15_command_status') === null) await this.setCapabilityValue('ccm15_command_status', 'none');
    if (['queued', 'pending'].includes(this.getCapabilityValue('ccm15_command_status'))) {
      const detail = 'App restarted while a command was pending; check the reported state. No command is automatically resent.';
      await this.setCapabilityValue('ccm15_command_status', 'unconfirmed');
      await this.setCapabilityValue('ccm15_command_detail', detail);
      await this.setWarning(detail); this.commandWarning = true;
    }
    if (['unconfirmed', 'rejected', 'fault'].includes(this.getCapabilityValue('ccm15_command_status'))) this.commandWarning = true;
    if (this.getCapabilityValue('ccm15_command_detail') === null) {
      await this.setCapabilityValue('ccm15_command_detail', this.getCapabilityValue('ccm15_command_status') === 'none'
        ? 'No commands recorded' : 'Result detail unavailable');
    }
    // Resume only a recent read-back expectation, never the physical request.
    // If history was truncated or a newer result exists, preserve the warning.
    if (this.getCapabilityValue('ccm15_command_status') === 'unconfirmed') {
      const history = this.homey.settings.get('command_diagnostics');
      const last = Array.isArray(history) ? [...history].reverse().find(d => d.deviceId === this.getData().id) : null;
      const expiresAt = Date.parse(last?.updatedAt) + 60000;
      if (last?.status === 'unconfirmed' && last.commandId && last.writes === 1 && last.expected && expiresAt > Date.now()) {
        this.latestCommandId = last.commandId;
        this.unconfirmedCommand = { diagnostic: last, expiresAt, generation: this.generation };
      }
    }
    this.client = this.homey.app.attach(this);
    for (const cap of EDITABLE_CAPS) if (this.hasCapability(cap)) this.registerCapabilityListener(cap, value => this.queueUiChange(cap, value));
    await this.refresh().catch(this.error);
    await this.homey.app.refreshGatewayMetadata(this.client).catch(this.error);
  }
  async queueUiChange(cap, value) {
    this.assertControlEnabled();
    if (cap === 'onoff') { if (typeof value !== 'boolean') throw new Error('Power must be boolean'); }
    else if (CLIMATE_CAPS[cap]) this.validateClimatePatch({ [CLIMATE_CAPS[cap]]: value });
    else if (LOCK_CAPS[cap]) lockParameter(LOCK_CAPS[cap], this.lockValue(LOCK_CAPS[cap], value));
    else throw new Error('Unknown control capability');
    const key = LOCK_CAPS[cap] ? `lock:${LOCK_CAPS[cap]}` : 'climate';
    const commandId = randomUUID(); this.latestCommandId = commandId;
    // The latest mode selection supersedes a preceding power switch. Turning
    // off supersedes a preceding mode selection, while preserving other edits.
    const discard = ['ccm15_mode', 'thermostat_mode'].includes(cap) ? ['onoff', cap === 'ccm15_mode' ? 'thermostat_mode' : 'ccm15_mode']
      : cap === 'onoff' && !value ? ['ccm15_mode', 'thermostat_mode'] : [];
    this.uiChanges.submit(key, { [cap]: value }, commandId, discard);
    await this.homey.app.recordCommand(this, { commandId, slot: this.getData().slot, kind: key, status: 'selecting',
      detail: 'Selecting; the final choice is queued after 1 second without changes', durationMs: 0, writes: 0, observations: [] }).catch(this.error);
  }
  lockValue(kind, value) { return ['coolLimit', 'heatLimit'].includes(kind) ? value === 'unlocked' ? null : Number(value) : value; }
  async dispatchUiChange(draft) {
    if (!this.uiChanges.isCurrent(draft)) return;
    const options = { commandId: draft.id, shouldSend: () => this.uiChanges.isCurrent(draft) };
    try {
      if (draft.key.startsWith('lock:')) {
        const cap = Object.keys(draft.values)[0], kind = LOCK_CAPS[cap];
        return await this.setLock(kind, this.lockValue(kind, draft.values[cap]), options);
      }
      const patch = Object.fromEntries(Object.entries(draft.values).filter(([cap]) => CLIMATE_CAPS[cap]).map(([cap, value]) => [CLIMATE_CAPS[cap], value]));
      if (draft.values.onoff === undefined) return await this.change(patch, options);
      return await this.change(state => ({ ...patch, mode: draft.values.onoff ? patch.mode || this.startMode(state) : 'off' }), options);
    } catch (error) {
      // Admission can fail before the gateway creates its own diagnostic.
      if (this.latestCommandId === draft.id && this.getCapabilityValue('ccm15_command_status') === 'selecting') {
        await this.homey.app.recordCommand(this, { commandId: draft.id, slot: this.getData().slot, kind: draft.key,
          status: 'rejected', detail: error.message, durationMs: 0, writes: 0, observations: [] }).catch(this.error);
      }
      throw error;
    }
  }
  startMode(state) { return state.mode !== 'off' ? state.mode : this.getStoreValue('last_active_mode') || this.getSetting('start_mode'); }
  assertControlEnabled() {
    if (this.getSetting('enable_control') !== true) throw new Error('Read-only mode: control is disabled');
    if (this.stopped || this.homey.app.stopping) throw new Error('App or device is stopping; no command queued');
  }
  validateClimatePatch(patch) {
    validatePatch(patch);
    if (patch.swing !== undefined && this.getSetting('indoor_type') !== 'wall_split') throw new Error('Swing control is available only for configured wall split units');
    if (patch.heater !== undefined && !this.getSetting('heater_supported')) throw new Error('Auxiliary heater hardware is not confirmed');
  }
  getReportedCapabilityValue(cap) { return this.getCapabilityValue(REPORTED_CAPS[cap] || cap); }
  async refresh() { return this.homey.app.refresh(this.client); }
  async setPower(value, options) {
    if (typeof value !== 'boolean') throw new Error('Power must be boolean');
    return this.change(state => ({ mode: value ? this.startMode(state) : 'off' }), options);
  }
  async change(patch, options) {
    if (typeof patch !== 'function') {
      this.validateClimatePatch(patch);
      patch = { ...patch };
    }
    return this.control((client, slot, controlOptions) => client.change(slot, patch, controlOptions), options);
  }
  async setLock(kind, value, options) {
    lockParameter(kind, value);
    return this.control((client, slot, controlOptions) => client.setLock(slot, kind, value, controlOptions), { ...options, kind: `lock:${kind}` });
  }
  async control(send, { background = false, kind = 'climate', commandId = randomUUID(), shouldSend = () => true } = {}) {
    const settings = this.getSettings();
    this.assertControlEnabled();
    const client = this.client, generation = this.generation ?? 0;
    const entry = this.homey.app.gateways.get(this.gatewayKey);
    const heatPumpSlots = settings.vrf_policy === 'heat_pump' ? parseGroupSlots(settings.vrf_group_slots, this.getData().slot) : undefined;
    const groupNames = Object.fromEntries([...(entry?.devices || [])].map(d => [d.getData().slot, d.getName?.() || `a${d.getData().slot}`]));
    const acceptedAt = Date.now(); this.latestCommandId = commandId;
    // A UI callback acknowledges queue admission, not execution. Flow actions
    // await completed below. UI drafts are held separately from reported state.
    await this.homey.app.recordCommand(this, { commandId, slot: this.getData().slot, kind, status: 'queued',
      queuedAt: new Date(acceptedAt).toISOString(), durationMs: 0, writes: 0, observations: [] }).catch(this.error);
    const completed = (async () => {
      try {
        const states = await send(client, this.getData().slot, {
        controlEnabled: settings.enable_control === true, extrasPolicy: settings.extras_policy, password: settings.password,
        heaterSupported: settings.heater_supported === true, heatPumpSlots, groupNames,
        commandId, acceptedAt,
        shouldSend: () => !this.stopped && !this.homey.app.stopping && this.client === client
          && (this.generation ?? 0) === generation && this.getSetting('enable_control') === true && shouldSend(),
        onDiagnostic: diagnostic => this.homey.app.recordCommand(this, diagnostic),
        onStates: states => entry && this.homey.app.deliver(entry, states),
        });
        if (entry) await this.homey.app.deliver(entry, states);
        return true;
      } catch (error) {
        // Recovery reads are queued; their latency must not extend a UI callback.
        if (!this.stopped && !this.homey.app.stopping && this.client === client) this.refresh().catch(this.error);
        throw error;
      }
    })();
    if (!this.controlTasks) this.controlTasks = new Set();
    this.controlTasks.add(completed);
    completed.then(() => this.controlTasks.delete(completed), () => this.controlTasks.delete(completed));
    if (background) { completed.catch(error => this.error(error.message)); return; }
    return completed;
  }
  async updateState(state, error) {
    this.reportedState = state || null;
    const connected = !!state;
    const previous = this.getCapabilityValue('ccm15_connected');
    if (previous !== connected) await this.setCapabilityValue('ccm15_connected', connected);
    if (previous !== null && previous !== connected) this.homey.flow.getDeviceTriggerCard('connection_changed').trigger(this, { connected }).catch(this.error);
    if (!connected) { await this.setUnavailable(error ? 'Gateway read failed; displayed values are old' : 'Indoor unit absent from latest status'); return; }
    const signature = [state.raw, state.fahrenheit].join(':');
    const changed = this.stateSignature !== undefined && this.stateSignature !== signature;
    if (state.mode !== 'off' && state.mode !== 'unknown' && this.getStoreValue('last_active_mode') !== state.mode) await this.setStoreValue('last_active_mode', state.mode);
    const values = { onoff: state.mode === 'unknown' ? null : state.on,
      measure_temperature: state.measured, target_temperature: state.target,
      ccm15_mode: state.mode, ccm15_fan: state.fan, ccm15_error: state.errorCode,
      alarm_generic: state.errorCode !== 0, ccm15_swing: state.swing, ccm15_heater: state.heater,
      ccm15_swing_state: state.swing, ccm15_heater_state: state.heater,
      ccm15_mode_locked: state.modeLocked, ccm15_fan_locked: state.fanLocked,
      ccm15_remote_locked: state.remoteLocked, ccm15_cool_limit: state.coolLimit,
      ccm15_heat_limit: state.heatLimit, ccm15_locked_mode: String(state.lockedModeCode),
      ccm15_locked_fan: String(state.lockedFanCode), ccm15_unit: state.fahrenheit ? 'F' : 'C',
      ccm15_remote_lock_control: state.remoteLocked, ccm15_fault_label: state.faultLabel,
      ccm15_last_seen: new Date().toISOString(), ...controlState(state), ...restrictionStatus(state) };
    for (const [cap, reported] of Object.entries(REPORTED_CAPS)) values[reported] = values[cap];
    // Publish real sensors, restrictions, faults and reported climate throughout
    // editing/confirmation, but never reset a wheel that the user is changing.
    for (const [cap, value] of Object.entries(values)) {
      if (EDITABLE_CAPS.has(cap) && this.uiChanges?.isHolding()) continue;
      if (this.hasCapability(cap) && this.getCapabilityValue(cap) !== value) await this.setCapabilityValue(cap, value);
    }
    if (this.getAvailable?.() !== true) await this.setAvailable();
    if (!this.uiChanges?.isHolding()) await this.updateControlChoices(state).catch(this.error);
    await this.reconcileCommand(state);
    this.stateSignature = signature;
    if (changed) this.homey.flow.getDeviceTriggerCard('state_changed').trigger(this, {
      mode: state.mode, fan: state.fan, temperature: state.measured, target: state.target,
      fault: state.errorCode, swing: state.swing, heater: state.heater,
    }).catch(this.error);
  }
  async updateControlChoices(state) {
    this.choiceSignatures ??= new Map();
    for (const cap of Object.keys(controlState(state))) {
      if (!this.hasCapability(cap)) continue;
      const values = controlChoices(manifest, cap, state, this.getSettings());
      const signature = JSON.stringify(values);
      if (this.choiceSignatures.get(cap) === signature) continue;
      await this.setCapabilityOptions(cap, { ...this.getCapabilityOptions(cap), values });
      this.choiceSignatures.set(cap, signature);
    }
  }
  async reconcileCommand(state) {
    const pending = this.unconfirmedCommand;
    if (!pending) return;
    const d = pending.diagnostic, now = Date.now();
    if (this.stopped || this.homey.app.stopping || pending.generation !== this.generation
      || pending.expiresAt <= now || this.latestCommandId !== d.commandId) { this.unconfirmedCommand = null; return; }
    if (differences(d.expected, state).length || d.kind === 'climate' && state.errorCode) return;
    this.unconfirmedCommand = null; // Consume before awaiting publication to avoid duplicate results.
    const updatedAt = new Date(now).toISOString();
    const elapsed = now - Date.parse(d.updatedAt);
    const durationMs = Number.isFinite(elapsed) ? d.durationMs + Math.max(0, elapsed) : d.durationMs;
    const processingMs = Number.isFinite(elapsed) ? d.processingMs + Math.max(0, elapsed) : d.processingMs;
    const actual = snapshot(state);
    await this.homey.app.recordCommand(this, { ...d, status: 'confirmed', confirmedLate: true, actual,
      mismatches: [], updatedAt, durationMs, processingMs,
      detail: 'State confirmed by a later gateway read; command was not resent',
      observations: [...d.observations, { afterMs: processingMs, actual, mismatches: [], source: 'later_read' }],
    });
  }
  async onSettings({ newSettings }) {
    validateAddress(newSettings.host, newSettings.port);
    if (newSettings.password && (!/^\d{1,10}$/.test(newSettings.password) || Number(newSettings.password) > 0xffffffff)) throw new Error('Invalid numeric password');
    if (newSettings.enable_control && newSettings.extras_policy === 'blocked') throw new Error('Confirm swing/heater policy before enabling control');
    if (newSettings.vrf_policy === 'heat_pump') parseGroupSlots(newSettings.vrf_group_slots, this.getData().slot);
    this.generation = (this.generation ?? 0) + 1;
    this.unconfirmedCommand = null;
    this.uiChanges?.cancel();
    if (this.getCapabilityValue('ccm15_command_status') === 'selecting') {
      await this.setCapabilityValue('ccm15_command_status', 'none');
      await this.setCapabilityValue('ccm15_command_detail', 'Uncommitted selection cancelled by settings change; no command sent');
    }
    await this.applyCapabilityProfile(newSettings);
    // Homey applies settings after this callback; reconnect using the proposed address.
    this.homey.app.detach(this);
    this.client = this.homey.app.attach(this, newSettings);
  }
  async applyCapabilityProfile(settings) {
    for (const cap of ['ccm15_swing_state', 'ccm15_heater_state', 'ccm15_mode_restriction', 'ccm15_fan_restriction', 'ccm15_cooling_limit_control', 'ccm15_heating_limit_control', 'ccm15_remote_lock_control', 'ccm15_command_status', 'ccm15_command_detail', 'ccm15_fault_label', ...Object.values(REPORTED_CAPS), 'ccm15_cooling_limit_status', 'ccm15_heating_limit_status', 'ccm15_mode_restriction_status', 'ccm15_fan_restriction_status']) if (!this.hasCapability(cap)) await this.addCapability(cap);
    // The user's native picker opens its last entry. Append a standard mode
    // control there; keep the original hidden capability so existing Flows
    // and device identities remain intact. New pairing uses the same order.
    if (!this.hasCapability('thermostat_mode')) await this.addCapability('thermostat_mode');
    for (const [cap, allowed] of [
      ['ccm15_swing', settings.indoor_type === 'wall_split'],
      ['ccm15_heater', settings.heater_supported === true],
    ]) {
      if (!allowed && this.hasCapability(cap)) await this.removeCapability(cap);
      if (allowed && !this.hasCapability(cap)) {
        await this.addCapability(cap);
        this.registerCapabilityListener(cap, value => this.queueUiChange(cap, value));
      }
    }
  }
  async onDeleted() { await this.onUninit(); }
  async onUninit() { this.stopped = true; this.unconfirmedCommand = null; this.uiChanges?.cancel(); this.generation = (this.generation ?? 0) + 1; this.homey.app.detach(this); }
};
