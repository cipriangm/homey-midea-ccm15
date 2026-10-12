# Development and releases

The repository holds the distributable Homey app. Installation-specific QA
scripts, private captures, network addresses and hub/device identities are
excluded. The Homey SDK is supplied on the hub at runtime; development tools
and node_modules are not committed.

## Checks

Node.js 22 and Python 3 can run the retained offline checks:

```sh
node --test tests/*.test.js
python3 scripts/check-reference.py
```

The distributable suite contains 110 tests. GitHub Actions runs these checks
on pushes and pull requests, using fixtures and simulated/local transport.
The workflow has read-only repository access and no Homey credentials or
automatic App Store publishing step.

For publish-level validation, install Homey CLI separately and run:

```sh
npm install --global homey@4.6.0
homey app validate --level publish
```

See [local installation](PUBLIC_SETUP.md) before using the CLI with a real
Homey. Explicitly select your own hub; offline test success is not proof of
hardware compatibility or permission to control a device.

## Versions

Use small commits that explain the change. Update app.json, package.json and
.homeychangelog.json together for an application release. Tag the tested
commit using its version, for example v0.1.13. Mark pre-certification GitHub
releases as pre-releases. A GitHub tag or release is separate from Homey's
Draft, Test, certification and Live states.

Version 0.1.13 is the certification correction submitted as Homey build 5.
Its runtime files remain identical to that submitted build. App name, public
support contact and three app cover images address the prior review. The
owner reserved 1.0.0 for after Athom approval. This repository's additional
contribution guides, issue templates and CI configuration do not change the
application's runtime behavior.
