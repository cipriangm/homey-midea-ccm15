'use strict';
const http = require('node:http');
const { parseStatus, command, lockCommand } = require('./protocol');
const { guardSharedHeatPump } = require('./vrf');
const CONFIRM_DELAYS = Object.freeze([1000, 1000, 2000, 3000, 4000, 4000, 4000, 4000, 4000]);
const CONFIRM_BUDGET_MS = 30000;
const snapshot = state => state ? Object.fromEntries(['mode', 'fan', 'target', 'swing', 'heater', 'fahrenheit', 'errorCode', 'faultLabel', 'lockedMode', 'lockedFan', 'coolLimit', 'heatLimit', 'remoteLocked'].map(k => [k, state[k]])) : null;
// Observed MI2 power Off can clear operational swing and report a stopped fan.
// Preserve both parameters on the wire. These narrow stopped-state exceptions
// never accept a different running speed or an auxiliary heater mismatch.
const stoppedSwing = (expected, actual) => expected?.mode === 'off' && actual?.mode === 'off'
  && expected.swing === true && actual.swing === false;
const stoppedFan = (expected, actual) => expected?.mode === 'off' && actual?.mode === 'off'
  && ['auto', 'low', 'medium', 'high'].includes(expected.fan) && actual.fan === 'off';
const differences = (expected, actual) => !actual ? ['indoor absent'] : Object.keys(expected)
  .filter(k => expected[k] !== actual[k] && !(k === 'swing' && stoppedSwing(expected, actual))
    && !(k === 'fan' && stoppedFan(expected, actual)));

function validateAddress(host, port = 80) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(host) || host.length > 253
    || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway host/port');
}
function request(host, port, path, timeout = 5000) {
  validateAddress(host, port);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port, path, agent: false }, res => {
      // py-ccm15 async_send_state accepts 200 and 302 for ctrl.xml.
      // Do not follow Location: this may execute a second physical request.
      // A 302 body still needs password checking and a fresh state read-back.
      const controlResponse = path.startsWith('/ctrl.xml?');
      if (res.statusCode !== 200 && !(controlResponse && res.statusCode === 302)) {
        res.resume(); reject(new Error(`HTTP ${res.statusCode}; redirects refused`)); return;
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 65536) req.destroy(new Error('Response too large'));
      });
      res.on('error', reject);
      res.on('end', () => resolve(text));
    });
    const timer = setTimeout(() => req.destroy(new Error('Gateway timeout')), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
  });
}

class Gateway {
  constructor(host, port = 80, transport = request, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    validateAddress(host, port);
    Object.assign(this, { host, port, transport, sleep, tail: Promise.resolve() });
  }
  enqueue(fn) {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  async read(timeout = 5000) { return parseStatus(await this.transport(this.host, this.port, '/status.xml', timeout)); }
  poll() {
    if (!this.pendingPoll) {
      this.pendingPoll = this.enqueue(() => this.read()).finally(() => { this.pendingPoll = null; });
    }
    return this.pendingPoll;
  }
  change(slot, patchOrFunction, options = {}) {
    return this.execute(slot, 'climate', (current, fresh) => {
      const patch = typeof patchOrFunction === 'function' ? patchOrFunction(current) : patchOrFunction;
      const prepared = command(slot, current, patch, options);
      guardSharedHeatPump(fresh, slot, prepared.expected.mode, options.heatPumpSlots, options.groupNames);
      return { ...prepared, requested: patch };
    }, options);
  }
  setLock(slot, kind, value, options = {}) {
    return this.execute(slot, `lock:${kind}`, (current, fresh) => {
      const prepared = lockCommand(slot, current, kind, value, options);
      if (kind === 'mode' && value !== 'unlocked' && value !== null) guardSharedHeatPump(fresh, slot, value, options.heatPumpSlots, options.groupNames);
      return { ...prepared, requested: { [kind]: value } };
    }, options);
  }
  execute(slot, kind, prepare, options) {
    if (options.controlEnabled !== true) return Promise.reject(new Error('Read-only mode: control is disabled'));
    const accepted = options.acceptedAt ?? Date.now();
    return this.enqueue(async () => {
      const started = Date.now();
      const diagnostic = { commandId: options.commandId, slot, kind, queuedAt: new Date(accepted).toISOString(),
        startedAt: new Date(started).toISOString(), queuedForMs: started - accepted, status: 'pending', writes: 0, observations: [] };
      const report = async () => {
        diagnostic.updatedAt = new Date().toISOString(); diagnostic.durationMs = Date.now() - accepted;
        diagnostic.processingMs = Date.now() - started;
        // A diagnostic/storage error must never affect or repeat a physical command.
        try { await options.onDiagnostic?.(JSON.parse(JSON.stringify(diagnostic))); } catch (_) {}
      };
      const publish = async states => {
        // Only observed states are published, including partial or unrelated changes.
        try { await options.onStates?.(states); } catch (_) {}
      };
      const checkLifecycle = () => {
        if (options.shouldSend && !options.shouldSend()) throw new Error('Command cancelled before dispatch: newer selection, device/settings change or app stop');
      };
      await report();
      try {
        checkLifecycle();
        const fresh = await this.read(); const current = fresh.get(slot);
        await publish(fresh);
        if (!current) throw new Error(`a${slot} absent; no command sent`);
        const prepared = prepare(current, fresh);
        diagnostic.before = snapshot(current); diagnostic.requested = prepared.requested; diagnostic.expected = { ...prepared.expected, fahrenheit: false };
        checkLifecycle();
        // Exactly one dispatch. A transport error after this point is an uncertain outcome.
        diagnostic.writes = 1;
        try {
          const response = await this.transport(this.host, this.port, prepared.path);
          const ret = /<ret>\s*(\d+)\s*<\/ret>/.exec(response);
          diagnostic.responseCode = ret ? Number(ret[1]) : null;
        } catch (error) {
          // The gateway may have applied a request whose HTTP response was lost.
          diagnostic.transportError = error.message.replace(/\/ctrl\.xml\?\S+/g, '[control request]');
        }
        if (diagnostic.responseCode === 250) { diagnostic.status = 'rejected'; throw new Error('Gateway rejected password'); }
        await report();
        // Firmware ret=1 means Busy/Timeout. Read-back may still resolve it; never resend.
        // Real CCM15 testing found stale state beyond 16 seconds. UI callbacks
        // already acknowledge admission; Flow actions can await these nine reads.
        const deadline = Date.now() + CONFIRM_BUDGET_MS;
        for (const delay of CONFIRM_DELAYS) {
          if (Date.now() + delay >= deadline) break;
          await this.sleep(delay);
          let states;
          try { states = await this.read(Math.max(1, Math.min(3000, deadline - Date.now()))); }
          catch (_) { diagnostic.observations.push({ afterMs: Date.now() - started, readFailed: true }); continue; }
          const actual = states.get(slot);
          diagnostic.offSwingStopped = stoppedSwing(diagnostic.expected, actual);
          diagnostic.offFanStopped = stoppedFan(diagnostic.expected, actual);
          diagnostic.actual = snapshot(actual); diagnostic.mismatches = differences(diagnostic.expected, actual);
          diagnostic.observations.push({ afterMs: Date.now() - started, actual: diagnostic.actual, mismatches: diagnostic.mismatches });
          await publish(states);
          if (kind === 'climate' && actual?.errorCode) {
            diagnostic.status = 'fault';
            throw new Error(`Indoor fault ${actual.errorCode} (${actual.faultLabel}) after command; check unit and VRF modes; no automatic resend`);
          }
          if (!diagnostic.mismatches.length) { diagnostic.status = 'confirmed'; await report(); return states; }
          await report();
        }
        diagnostic.status = 'unconfirmed';
        const detail = diagnostic.mismatches?.map(k => `${k}: expected ${diagnostic.expected[k]}, reported ${diagnostic.actual?.[k]}`).join('; ') || 'no readable state';
        throw new Error(`Command sent but state not confirmed (${detail}); no automatic resend`);
      } catch (error) {
        if (diagnostic.status === 'pending') diagnostic.status = diagnostic.writes ? 'unconfirmed' : 'rejected';
        diagnostic.detail = error.message.replace(/\/ctrl\.xml\?\S+/g, '[control request]');
        await report(); throw error;
      }
    });
  }
}
module.exports = { Gateway, request, validateAddress, CONFIRM_DELAYS, CONFIRM_BUDGET_MS, snapshot, differences, stoppedSwing, stoppedFan };
