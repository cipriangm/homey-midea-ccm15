# Contributing

Bug reports, documentation improvements and pull requests are welcome. Read
[setup and scope](docs/PUBLIC_SETUP.md) and
[protocol notes](docs/PUBLIC_PROTOCOL_NOTES.md) before proposing device support.

Run these checks before opening a pull request:

```sh
node --test tests/*.test.js
python3 scripts/check-reference.py
```

Keep app, driver, capability and Flow IDs stable. Preserve settings that were
not requested, prepare controls from fresh status, serialize gateway commands
and retain read-back confirmation. Do not automatically repeat an uncertain
physical request. Protocol additions need a primary source or reproducible
firmware evidence; do not infer undocumented fields from their apparent value.

Automated tests use fixtures and simulated or local test transport. Testing
against actual HVAC hardware must be deliberate and authorized by its owner;
report hardware checks separately from automated checks.

Include a clear description of the problem, the resulting behavior and the
checks performed. Remove credentials, site addresses, device identities and
personal information from issues, commits and pull requests. Respect the
retained protocol license and separate Midea brand-asset attribution.
