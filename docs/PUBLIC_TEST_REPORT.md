# Midea / CCM15 v0.1.13 — validation scope

Version 0.1.13 is a listing correction on 12 October 2026: the App Store name,
public support contact and three cover images address Athom's review of build
4. Control, discovery, pairing, capabilities, Flow definitions and driver
assets retain their previous bytes. Automated tests and publish-level
validation are rerun; the physical checks below are retained evidence for
the unchanged runtime, not newly performed 0.1.13 hardware tests. The local
Homey installation remains 0.1.12. See
[certification changes](CERTIFICATION_CHANGES_v0.1.13.md).

Latest pairing checks completed on 11 October 2026 (local time); physical control evidence was collected on 10 October 2026. Homey Pro Early 2023 firmware 13.5.2-rc.4, one CCM15 with nine MI2 indoor units on one V6i heat-pump outdoor. Seven indoors are ducts and two are wall splits. This is community validation on that installation, not universal firmware certification.

## CCM15 firmware observation

On 11 October 2026 (local time), query-free GET reads confirmed the tested
gateway's reported name prefix `DZ230327V03` and nine populated slots a0–a8.
The owner reports that the same gateway failed to detect the connected MI2
indoors before a firmware update and detected them afterward. The earlier
firmware and the flashed image have not been identified or tested by the app
developer. The programming photograph does not establish the CCM15 firmware
version; see [Protocol and firmware scope](PUBLIC_PROTOCOL_NOTES.md).
No minimum firmware version or compatibility with all older versions is claimed.
These additional checks were reads only, with zero HVAC control writes.

## Automated checks

The private development suite passes 111 tests. The distributable suite passes 110 tests; it omits the site-specific installation guard test. HTTP writes in automated tests use simulated transport or a local test server. Decoder differential validation passes 2,792 payloads against the retained MIT reference, allowing only documented effective-power and temperature conversion adaptations. Homey CLI publish-level validation passes. Athom certification is separate.

## Retained actual control checks from v0.1.10

- Read/discover nine indoors, read-only pairing session, stable identities, and existing-pair exclusion, without duplicate devices.
- Flow target-temperature changes and restoration on all nine, preserving mode/fan/auxiliary bits and other indoors. Two rapid native temperature edits produce one final request.
- Power capability and custom Flow power controls; Cool/Heat/Dry/Fan modes and Auto/Low/Medium/High fans; mode/fan restrictions, both temperature limits and unlock, wireless remote lock while central control remains available.
- Swing on/off on both wall splits, preservation from fresh state, strict confirmation, and confirmed power Off with stopped-fan/swing normalization. Invalid active Fan Off, Off-unit swing and unsupported duct/heater requests are rejected before writes.
- Shared-circuit Heat/Cool conflict and independent Auto rejection before writes, without controlling peers.
- A complete manual Flow with connection condition and temperature action, plus actual Flows triggered by state, command result, mode, fan and connection events.
- Device disconnection via a temporary Homey device port setting, rejection of unavailable/stale device conditions, and recovery on the original port. Connection-change Flows fired both on loss and recovery. Temporary Flows/variables were removed and all physical settings restored.

After the final local installation, app-only restart preserved all nine device identities/settings, kept physical settings unchanged and replayed no command. Four read observations over approximately 46 seconds found all nine connected/available, no faults and no device warning messages. Readable inactive limit/restriction statuses were verified on all nine. This short observation is not a multi-day soak test.

Every confirmed request is dispatched once. Confirmations up to approximately 24.5 seconds were observed. A 30-second confirmation budget replaced the initial shorter window; it does not change the gateway's internal update interval. Previous failed test runs identified delayed read-back and Off-state normalization and were corrected/retested, rather than hidden by resending.

## Actual discovery and metadata checks in v0.1.11

Eight cases passed through a real Homey pairing session: preserve existing identities/names/profiles; quick discovery; a fresh full private /24 scan; cancellation; rejection of public/oversized ranges; import all nine configured indoor names without duplicates; manual entry and opt-out; read-only metadata labels on every existing indoor. The complete scan checked 254 usable addresses in approximately 37 seconds and found one validated CCM15. There were zero physical control writes and zero new devices created; the QA session was removed. Physical settings and control diagnostics were unchanged.

Homey and the gateway are on separate routed networks in this installation. Native MAC discovery/ARP did not expose the gateway's MAC; HTTP discovery worked. Native MAC strategy integration is unit tested, not claimed as a hardware success here. Those backend checks did not cover framework view navigation; the navigation issue reported afterward is addressed and separately verified below.

## Actual pairing navigation checks in v0.1.12

A top-level helper named `$` in the custom view shadowed Homey's jQuery during native view transitions. A regression test with page and framework navigation in the same global context fails against the previous page and passes with the scoped fix. The suite also checks partial/full existing-pair summaries, no-duplicate completion, a working Close, preservation of framework globals and custom-view re-entry.

The corrected version is installed and active on the tested Homey. Homey Web found the physical gateway with nine already paired indoors, displayed the explicit completion message and closed successfully. The official iPhone 5/SE pairing simulator also completed and closed; the owner independently confirmed the completion message and Close on iPhone.

A temporary read-only HTTP fixture verified the new-device route in the actual Homey Web interface: nine native candidates, Previous/re-entry, selection/addition of one indoor with control disabled, and a new pairing offering only the remaining eight. The fixture device was available, had its own stable gateway identity and was removed after verification. The fixture server was stopped; its 27 requests included zero control requests. The nine original device identities/names/profiles, gateway settings and command diagnostics were unchanged. No physical HVAC commands were repeated for this UI-only update.

## Single-indoor deletion and re-addition

A further actual native pairing check used a read-only two-indoor fixture. Both
were added, renamed and assigned zones; their names/zone IDs were saved before
deleting only the first. Re-pairing offered only that deleted indoor. Its new
internal Homey ID differed from its former ID while the CCM15 slot identity
remained the same. Native pairing used its configured CCM15 name and default
zone; restoring the saved custom name/zone explicitly through the API was
verified. The peer's identity/name/zone stayed unchanged. This restoration is
a test procedure, not an automatic deleted-device backup feature in the app.
Both fixtures were removed and the server stopped after 21 read requests and
zero control requests. Original physical devices were never removed, and their
names/zones/identities/profiles and physical states remained unchanged.

## Indoor profiles and native icon preferences

On 11 October 2026 (local time), live reads confirmed the manually configured
seven ducted and two wall-split profiles, with Swing absent on ducts and
present on splits. Seven native Homey icon overrides were set to the
ventilation symbol; the splits retained their original air conditioner icon.
The ducts were subsequently changed to Homey's standard rectangular grille
symbol (climate3), at the owner's request. API read-back verified all nine
icons, and the native device list displayed the different symbols. The latter
change preserved all stable native settings, including the estimates noted
below. Icons remain a separate Homey preference; automatic
type detection or automatic icon changes are not app features in 0.1.12.

Device identities, names, zones, control profiles, physical settings and
command diagnostics were preserved. Saving the first icon through Homey's
settings screen changed two blank native power estimates to 0 W. The API
rejected null values and retained the zeros when those keys were omitted;
those two estimates therefore remain changed. They are nominal Homey fields,
not gateway readings. The remaining icon overrides used the device API and
preserved their blank estimates. This check sent zero HVAC control requests
and did not reinstall or change the app runtime.

## Limits

Gateway-reported states were inspected; physical flap motion and infrared/wired-keypad behavior were not independently observed by the tester. Auxiliary electric heaters, Fahrenheit control, real refrigeration faults, other CCM15 firmware/model combinations and Homey Cloud/Bridge are not hardware validated. Long-term testing over days remains useful. The additional 60-second late reconciliation branch is tested offline and was not required beyond the new 30-second budget in final hardware runs.

Some custom-enum fallback choices remain declared in this Homey API despite requested dynamic options; invalid choices are rejected. Inactive limits/restrictions have explicit No limit/Unlocked readings. Initial Operating mode and stable mobile selection were confirmed by the owner for the retained native-control structure.

Local identities, addresses, room names and raw Homey captures are deliberately excluded from this distributable report and source package.
