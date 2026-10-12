'use strict';
const { Gateway } = require('../lib/gateway');
const fs = require('node:fs');
const { parseStatus } = require('../lib/protocol');
(async () => {
  if (!process.argv[2]) throw new Error('Usage: node scripts/read-status.js HOST [PORT], or --fixture FILE');
  const states = process.argv[2] === '--fixture' ? parseStatus(fs.readFileSync(process.argv[3], 'utf8'))
    : await new Gateway(process.argv[2], Number(process.argv[3] || 80)).poll();
  console.table([...states.values()].map(s => ({ slot: `a${s.slot}`, mode: s.mode, fan: s.fan,
    measured_C: s.measured, target_C: s.target, fault: s.errorCode })));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
