'use strict';

function parseGroupSlots(value, ownSlot) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Configure the indoor slots on the same VRF outdoor unit');
  const slots = value.split(',').map(part => {
    const text = part.trim();
    if (!/^(?:a)?(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(text)) throw new Error('VRF slots must be comma-separated addresses a0–a63');
    return Number(text.replace(/^a/, ''));
  });
  if (new Set(slots).size !== slots.length || !slots.includes(ownSlot)) throw new Error('VRF group must contain this indoor slot once, without duplicates');
  return slots;
}

function guardSharedHeatPump(states, ownSlot, mode, slots, names = {}) {
  if (!slots || mode === 'off') return;
  if (mode === 'auto') throw new Error('Independent Auto is disabled for this shared VRF; choose Cool or Heat');
  // Conservative V6i policy: Fan and Dry join the non-heating side.
  // No priority switch, automatic peer shutdown or thermal-mode override.
  const heat = mode === 'heat';
  for (const slot of slots) {
    if (slot === ownSlot) continue;
    const name = names[slot] || `a${slot}`;
    const peer = states.get(slot);
    if (!peer) throw new Error(`VRF state missing for ${name}; refresh before controlling an active unit`);
    if (!peer.on) continue;
    if (peer.mode === 'auto' || peer.mode === 'unknown') throw new Error(`VRF mode uncertain for ${name}; choose an explicit compatible mode first`);
    if ((peer.mode === 'heat') !== heat) throw new Error(`VRF mode conflict: ${name} is ${peer.mode}; choose compatible modes or stop that unit first`);
  }
}

module.exports = { parseGroupSlots, guardSharedHeatPump };
