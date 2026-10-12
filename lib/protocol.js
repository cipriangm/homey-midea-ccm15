'use strict';
// Port of HomeOps/py-ccm15; see docs/reference and THIRD_PARTY_NOTICES.md.
const MODES = Object.freeze({ cool: 0, heat: 1, dry: 2, fan: 3, off: 4, auto: 5 });
const FANS = Object.freeze({ auto: 0, low: 2, medium: 3, high: 4, off: 5 });
const label = (map, code) => Object.keys(map).find(k => map[k] === code) || 'unknown';
const celsius = (value, fahrenheit) => fahrenheit ? (value - 32) * 5 / 9 : value;
function faultLabel(code) {
  if (code === 0) return 'OK';
  // Firmware tohex converts only 10..15 to A..F; higher P indices are decimal.
  const index = code <= 16 ? code - 1 : code - 17;
  const suffix = index >= 10 && index <= 15 ? index.toString(16).toUpperCase() : String(index);
  return `${code <= 16 ? 'E' : 'P'}${suffix}`;
}

function decode(raw, slot) {
  raw = raw.trim().replace(/,$/, '');
  if (!/^[0-9a-f]{14}$/i.test(raw)) throw new Error(`Invalid payload at a${slot}`);
  const b = Buffer.from(raw, 'hex');
  const fahrenheit = !!(b[0] & 1);
  const reportedModeCode = (b[3] >> 2) & 7;
  // Live CCM15 midea.js: byte 3 bit 0 is power; clear means Off.
  const powerBit = !!(b[3] & 1);
  const modeCode = powerBit ? reportedModeCode : MODES.off;
  const fanCode = (b[3] >> 5) & 7;
  const targetRaw = (b[4] >> 3) + (fahrenheit ? 62 : 0);
  const measuredRaw = b[6] < 128 ? b[6] : b[6] - 256;
  return Object.freeze({ slot, raw, fahrenheit, modeCode, reportedModeCode, powerBit, fanCode,
    mode: label(MODES, modeCode), fan: label(FANS, fanCode),
    on: modeCode !== 4, targetRaw,
    target: celsius(targetRaw, fahrenheit), measured: celsius(measuredRaw, fahrenheit),
    swing: !!(b[4] & 2), heater: !!(b[4] & 1), errorCode: (b[2] >> 2) & 63,
    modeLocked: !!(b[3] & 2), fanLocked: !!(b[5] & 32), remoteLocked: !!(b[5] & 64),
    lockedModeCode: b[2] & 3, lockedFanCode: b[1] >> 5,
    lockedMode: !(b[3] & 2) ? 'unlocked' : (b[2] & 3) === 1 ? 'cool' : (b[2] & 3) === 2 ? 'heat' : 'unknown',
    lockedFan: !(b[5] & 32) ? 'unlocked' : label(FANS, b[1] >> 5),
    faultLabel: faultLabel((b[2] >> 2) & 63),
    coolLimit: b[5] & 8 ? celsius((b[0] >> 3) + (fahrenheit ? 62 : 0), fahrenheit) : null,
    heatLimit: b[5] & 16 ? celsius((b[1] & 31) + (fahrenheit ? 62 : 0), fahrenheit) : null,
  });
}

function addressParams(slot, state, options) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 63 || state.slot !== slot) throw new Error('Invalid slot');
  const params = new URLSearchParams({ ac0: String(slot < 32 ? 2 ** slot : 0), ac1: String(slot >= 32 ? 2 ** (slot - 32) : 0) });
  if (options.password) {
    if (!/^\d{1,10}$/.test(options.password) || Number(options.password) > 0xffffffff) throw new Error('Password must be numeric uint32');
    params.set('pwd', String((Number(options.password) ^ 0x56789) >>> 0));
    params.set('utsxxx', String((options.now ?? Date.now()) % 1000));
  }
  return params;
}

// Verified in this gateway's midea.js: send_lock, lt, opt, unlock_me.
// These requests carry no mode/fan/temp/sw/ht fields and target one indoor.
const LOCKS = Object.freeze({ mode: 1, fan: 6, coolLimit: 4, heatLimit: 5, remote: 7 });
function lockParameter(kind, value) {
  if (!Object.hasOwn(LOCKS, kind)) throw new Error('Unsupported lock type');
  if (value === null || value === 'unlocked' || (kind === 'remote' && value === false)) return 99;
  if (kind === 'mode' && ['cool', 'heat'].includes(value)) return MODES[value];
  if (kind === 'fan' && ['low', 'medium', 'high'].includes(value)) return FANS[value];
  if (['coolLimit', 'heatLimit'].includes(kind) && Number.isInteger(value) && value >= 17 && value <= 30) return value;
  if (kind === 'remote' && value === true) return 0;
  throw new Error(kind === 'mode' ? 'Choose Cool, Heat or Unlocked for the mode restriction'
    : kind === 'fan' ? 'Choose Low, Medium, High or Unlocked for the fan restriction'
    : kind === 'remote' ? 'Remote control lock must be boolean'
    : 'Temperature limits must be integers from 17 to 30°C, or Unlocked');
}
function lockCommand(slot, state, kind, value, options = {}) {
  const parameter = lockParameter(kind, value);
  if (state.fahrenheit) throw new Error('Control in Fahrenheit is not validated; use Celsius');
  const params = addressParams(slot, state, options);
  params.set('lock', String(LOCKS[kind])); params.set('p', String(parameter));
  const key = { mode: 'lockedMode', fan: 'lockedFan', coolLimit: 'coolLimit', heatLimit: 'heatLimit', remote: 'remoteLocked' }[kind];
  return { path: `/ctrl.xml?${params}`, expected: { [key]: parameter === 99 ? (kind === 'remote' ? false : ['mode', 'fan'].includes(kind) ? 'unlocked' : null) : value }, kind, value };
}

// Deliberately narrow parser for the CCM15 wire grammar; no DTD/entities.
function parseStatus(xml) {
  if (typeof xml !== 'string' || xml.length > 65536 || /<!|&/.test(xml)) throw new Error('Invalid status XML');
  const body = xml.trim().replace(/^<\?xml[^?]*\?>\s*/, '');
  const root = /^<response>\s*([\s\S]*?)\s*<\/response>$/.exec(body);
  if (!root) throw new Error('Missing response root');
  const states = new Map(); const seen = new Set();
  const remainder = root[1].replace(/<a(\d+)>\s*([^<]*)\s*<\/a\1>/g, (_, index, value) => {
    const slot = Number(index);
    if (slot > 63 || seen.has(slot)) throw new Error('Invalid/duplicate slot');
    seen.add(slot);
    if (value.trim() !== '-') states.set(slot, decode(value, slot));
    return '';
  });
  if (remainder.trim() || !seen.size) throw new Error('Malformed or empty status XML');
  return states;
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid command');
  for (const k of Object.keys(patch)) if (!['mode', 'fan', 'target', 'swing', 'heater'].includes(k)) throw new Error('Unknown command field');
  for (const k of ['swing', 'heater']) if (patch[k] !== undefined && typeof patch[k] !== 'boolean') throw new Error('Auxiliary values must be boolean');
  if ((patch.mode !== undefined && !Object.hasOwn(MODES, patch.mode)) || (patch.fan !== undefined && !Object.hasOwn(FANS, patch.fan))) throw new Error('Unsupported mode/fan');
  if (patch.target !== undefined && (!Number.isInteger(patch.target) || patch.target < 17 || patch.target > 30)) throw new Error('Target must be an integer from 17 to 30°C');
}
function command(slot, state, patch, options = {}) {
  validatePatch(patch);
  if (!Number.isInteger(slot) || slot < 0 || slot > 63 || state.slot !== slot) throw new Error('Invalid slot');
  if (state.fahrenheit) throw new Error('Control in Fahrenheit is not validated; use Celsius');
  if (state.mode === 'unknown' || state.fan === 'unknown') throw new Error('Unknown mode/fan; refusing to overwrite');
  if (state.errorCode) throw new Error(`Unit fault ${state.faultLabel || state.errorCode}`);
  const mode = patch.mode ?? state.mode;
  let fan = patch.fan ?? state.fan;
  const target = patch.target ?? state.targetRaw;
  if (!Object.hasOwn(MODES, mode) || !Object.hasOwn(FANS, fan)) throw new Error('Unsupported mode/fan');
  if (patch.fan === 'off' && mode !== 'off') throw new Error('Fan Off is available only while the indoor is Off; use power Off to stop it');
  if (patch.swing === true && mode === 'off' && patch.mode !== 'off') throw new Error('Turn the indoor on before enabling swing');
  if (state.modeLocked && mode !== 'off' && mode !== state.lockedMode) throw new Error(`Mode is locked to ${state.lockedMode}`);
  if (state.fanLocked && fan !== state.fan && fan !== state.lockedFan) throw new Error(`Fan is locked to ${state.lockedFan}`);
  // Homey UI range is a conservative 17–30°C, not a claim about all Midea models.
  if (!Number.isInteger(target) || target < 17 || target > 30) throw new Error('Target must be an integer from 17 to 30°C');
  if ((mode === 'cool' && state.coolLimit !== null && target < state.coolLimit)
    || (mode === 'heat' && state.heatLimit !== null && target > state.heatLimit)) throw new Error('Target violates unit lock');
  if (mode !== 'off' && fan === 'off') {
    if (state.fanLocked && !['low', 'medium', 'high'].includes(state.lockedFan)) throw new Error('Unknown locked fan cannot be started');
    fan = state.fanLocked ? state.lockedFan : 'auto';
  }
  const params = addressParams(slot, state, options);
  params.set('mode', String(MODES[mode])); params.set('fan', String(FANS[fan])); params.set('temp', String(target));
  const swing = patch.swing ?? state.swing; const heater = patch.heater ?? state.heater;
  if (patch.heater !== undefined && !options.heaterSupported) throw new Error('Auxiliary heater hardware is not confirmed');
  if (options.extrasPolicy === 'preserve') {
    params.set('sw', String(Number(swing))); params.set('ht', String(Number(heater)));
  } else if (options.extrasPolicy === 'omit' && !state.swing && !state.heater && patch.swing === undefined && patch.heater === undefined) {
    // Only after user confirms this firmware has no applicable auxiliary features.
  } else throw new Error('Confirm swing/heater firmware policy before enabling control');
  return { path: `/ctrl.xml?${params}`, expected: { mode, fan, target, swing, heater } };
}

module.exports = { MODES, FANS, LOCKS, decode, parseStatus, command, lockCommand, lockParameter, validatePatch, faultLabel };
