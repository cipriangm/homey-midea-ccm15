# Certification changes in 0.1.13

On 12 October 2026, Athom rejected build 4 / version 0.1.12 with three
observations about its name, support contact and app image. Version 0.1.13
addresses those observations:

| Observation | Change |
|---|---|
| The app name contains a specific model | The App Store name is **Midea**. The driver remains **Midea CCM15 indoor unit**, making its supported hardware explicit. |
| No public feedback or support channel | The manifest contains `support: mailto:legaturi.ace7b@icloud.com`, provided for public support by the owner. |
| The app image is a product photo on white | All three app covers use the official Midea lifestyle image suggested by the reviewer. The driver retains its white-background product image. |

The supported protocol remains CCM15's local `status.xml` and `ctrl.xml`.
The name change does not add cloud, Wi-Fi-dongle or other gateway support.
App ID, driver ID, capabilities, Flow definitions, gateway discovery, pairing
and control source are retained. Source and asset hashes are compared with
the rejected version; only listing metadata, release metadata, three app
cover images and accompanying documentation differ.

Automated regression tests and publish-level validation are checked again
for this release. Existing physical-control and actual-pairing evidence is
retained for the unchanged runtime; those physical tests are not repeated
for a listing-only correction. This release does not report electrical
power or energy measurements. No gateway firmware is changed.

The source package omits private test reports, local addresses, device/hub
identities and credentials. See [asset attribution](STORE_ASSETS.md),
[hardware validation scope](PUBLIC_TEST_REPORT.md) and
[installation instructions](PUBLIC_SETUP.md).

Submitting a corrected build does not itself constitute Athom approval or
a Live release. The owner has reserved version **1.0.0** for after approval.
