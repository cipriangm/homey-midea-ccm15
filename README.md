# Midea for Homey — CCM15 integration

![Midea climate control](assets/images/large.png)

Native Homey Apps SDK v3 integration for Midea CCM15 VRF gateways using the local HTTP interface. No Home Assistant or Midea cloud account is required. Each populated indoor address is paired as an individual device. This is an independent community app.

Version 0.1.13. Features include verified gateway discovery, bounded local address search, configured indoor names, read-only gateway metadata, measured and target temperature, on/off state, operating modes, fan, optional swing, readable restrictions and limits, wireless remote control lock, fault/connection readings, diagnostic command results and custom Flow actions/conditions/triggers. New devices begin with control off; configure actual hardware, firmware compatibility and shared outdoor membership before enabling it.

## Setup and scope

- [Gateway firmware compatibility and the observed update requirement](docs/PUBLIC_SETUP.md#gateway-firmware-compatibility)
- [Configuring indoor types and different native Homey icons](docs/PUBLIC_SETUP.md#indoor-types-and-icons)
- [Discovery, stable identities and metadata](docs/DISCOVERY_AND_METADATA.md)
- [Pairing, controls, Flows and developer installation](docs/PUBLIC_SETUP.md)
- [Protocol sources and firmware observations](docs/PUBLIC_PROTOCOL_NOTES.md)
- [Validation scope and hardware limits](docs/PUBLIC_TEST_REPORT.md)
- [Asset sources](docs/STORE_ASSETS.md)

Each physical command is sent once, prepared from fresh state and verified by read-back. The app serializes requests and guards opposing modes on explicitly configured shared heat-pump circuits. Native UI edits wait one second after the last change. Custom Flow controls await confirmation; Reported tags expose gateway readings.

## Developer checks

```sh
node --test tests/*.test.js
python3 scripts/check-reference.py
node scripts/read-status.js --fixture tests/fixtures/live-status.xml
homey app validate --level publish
```

Python 3 and Node on PATH are needed for differential checks. The distributable contains 110 tests; a private site-specific installation guard and its test are excluded. CLI/authentication dependencies are development tools and are not bundled. Local installation uses your own Homey selection and login; see the setup guide.

## Attribution

Adapted protocol reference: [HomeOps/py-ccm15](https://github.com/HomeOps/py-ccm15), MIT, retained commit 4dc5c8df0531541a47be3bcb7ad33b57b7665f6f. License and original copyright are retained. Midea's brand/product assets remain outside the integration code's MIT grant. See THIRD_PARTY_NOTICES.md.

This source package excludes the owner's local addresses, hub/device identities, raw private test reports and credentials. Validation is scoped to the hardware documented in the report; Athom App Store certification is a separate process.

Pairing navigation is verified in the actual Homey interface. Fully paired gateways display a clear completion message and Close; new or remaining indoors open the native selection list. Previous returns to gateway selection. See the validation report for actual and simulated hardware scope.

## Support and certification changes

The App Store name is Midea; supported gateway hardware remains CCM15. Version 0.1.13 changes only the listing metadata and app cover. Device identities, Flow definitions and control logic are retained. See [certification changes](docs/CERTIFICATION_CHANGES_v0.1.13.md).

Contact [app support](mailto:legaturi.ace7b@icloud.com) for questions or bug reports. The app does not measure electrical power or energy. Any Homey on/off power approximation is a separate user-configured estimate, not a CCM15 reading.

## Working on the app

Use Issues for bug reports and suggestions, and pull requests for proposed code changes. See [contribution guidelines](CONTRIBUTING.md), [development and versions](docs/DEVELOPMENT.md), and [private security reports](SECURITY.md). The repository includes an offline GitHub Actions test workflow; App Store publishing remains a separate maintainer action.
