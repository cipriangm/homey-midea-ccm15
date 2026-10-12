"""Offline differential decoder check against the retained MIT upstream source.
Run with Python 3 and Node on PATH. No gateway access and no control requests.
"""
import importlib
import json
import math
import random
import subprocess
import sys
import types
from pathlib import Path

root = Path(__file__).resolve().parent.parent
package = types.ModuleType('ccm15_reference')
package.__path__ = [str(root / 'docs/reference')]
sys.modules[package.__name__] = package
reference = importlib.import_module('ccm15_reference.CCM15SlaveDevice').CCM15SlaveDevice
baseline = bytearray.fromhex('00000010d0001a')
payloads = []
for index in range(7):
    for value in range(256):
        payload = baseline.copy()
        payload[index] = value
        payloads.append(payload.hex())
rng = random.Random(15)
payloads += [bytes(rng.randrange(256) for _ in range(7)).hex() for _ in range(1000)]
code = """
const fs=require('node:fs');const {decode}=require('./lib/protocol');
const payloads=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(payloads.map(raw=>decode(raw,0))));
"""
actual = json.loads(subprocess.check_output(['node', '-e', code], cwd=root, input=json.dumps(payloads).encode()))
for raw, state in zip(payloads, actual):
    ref = reference(bytes.fromhex(raw))
    convert = (lambda t: t) if ref.is_celsius else (lambda t: (t - 32) * 5 / 9)
    expected = dict(reportedModeCode=ref.ac_mode, modeCode=ref.ac_mode if bytes.fromhex(raw)[3] & 1 else 4,
                    fanCode=ref.fan_mode,
                    targetRaw=ref.temperature_setpoint,
                    target=convert(ref.temperature_setpoint), measured=convert(ref.temperature),
                    fahrenheit=not ref.is_celsius, errorCode=ref.error_code,
                    swing=ref.is_swing_on, heater=ref.is_heater_on,
                    modeLocked=ref.is_ac_mode_locked, fanLocked=ref.fan_locked,
                    remoteLocked=ref.is_remote_locked,
                    lockedModeCode=ref.locked_ac_mode, lockedFanCode=ref.locked_wind)
    for key, value in expected.items():
        assert math.isclose(state[key], value, abs_tol=1e-10), (raw, key, state[key], value)
    for key, value, bit in [('coolLimit', ref.locked_cool_temperature, 8), ('heatLimit', ref.locked_heat_temperature, 16)]:
        expected_limit = convert(value) if bytes.fromhex(raw)[5] & bit else None
        if expected_limit is None:
            assert state[key] is None, (raw, key)
        else:
            assert math.isclose(state[key], expected_limit, abs_tol=1e-10), (raw, key)
print(f'PASS: {len(payloads)} payloads compared with upstream decoder; no network access.')
