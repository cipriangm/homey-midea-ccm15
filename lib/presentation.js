'use strict';

const LIMIT_MIN = 17, LIMIT_MAX = 30;
const TITLES = { cool: 'Cool', heat: 'Heat', low: 'Low', medium: 'Medium', high: 'High', auto: 'Auto', off: 'Off' };
const limitControl = value => value === null ? 'unlocked'
  : Number.isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX ? String(value) : 'unknown';
const describeLimit = value => value === null ? 'No limit'
  : Number.isFinite(value) ? `${Number(value.toFixed(2))}°C` : 'Unrecognized limit';

function restrictionStatus(state) {
  return {
    ccm15_cooling_limit_status: describeLimit(state.coolLimit),
    ccm15_heating_limit_status: describeLimit(state.heatLimit),
    ccm15_mode_restriction_status: !state.modeLocked ? 'Unlocked'
      : TITLES[state.lockedMode] ? `${TITLES[state.lockedMode]} only` : `Unrecognized code ${state.lockedModeCode}`,
    ccm15_fan_restriction_status: !state.fanLocked ? 'Unlocked'
      : TITLES[state.lockedFan] ? `${TITLES[state.lockedFan]} only` : `Unrecognized code ${state.lockedFanCode}`,
  };
}

function controlState(state) {
  return {
    thermostat_mode: state.mode,
    ccm15_fan: state.fan,
    ccm15_mode_restriction: state.lockedMode,
    ccm15_fan_restriction: ['unlocked', 'low', 'medium', 'high'].includes(state.lockedFan) ? state.lockedFan : 'unknown',
    ccm15_cooling_limit_control: limitControl(state.coolLimit),
    ccm15_heating_limit_control: limitControl(state.heatLimit),
  };
}

function controlChoices(manifest, cap, state, settings) {
  const reported = controlState(state)[cap];
  const values = cap === 'thermostat_mode' ? manifest.drivers[0].capabilitiesOptions.thermostat_mode.values
    : manifest.capabilities[cap].values;
  // A diagnostic fallback is shown only if it is the actual reported state.
  // Keep the real value visible even when this setup does not allow selecting it.
  return values.filter(value => value.id !== 'unknown' || reported === 'unknown')
    .filter(value => cap !== 'thermostat_mode' || settings.vrf_policy !== 'heat_pump' || value.id !== 'auto' || reported === 'auto')
    .filter(value => cap !== 'ccm15_fan' || value.id !== 'off' || state.mode === 'off' || reported === 'off');
}

module.exports = { restrictionStatus, controlState, controlChoices };
