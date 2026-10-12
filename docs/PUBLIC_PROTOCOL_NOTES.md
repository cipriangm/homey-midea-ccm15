# CCM15 protocol and verified scope

The decoder and HTTP request generation adapt the MIT-licensed [HomeOps/py-ccm15](https://github.com/HomeOps/py-ccm15) source at commit `4dc5c8df0531541a47be3bcb7ad33b57b7665f6f`. The retained upstream source and license are in reference/. The proprietary gateway firmware is not redistributed.

## Reads

GET status.xml is used for climate state. Populated a0–a63 entries decode into individual indoors; '-' is an absent slot. The unsigned address mask controls one selected slot, not all indoors. Raw mode/fan/temperature, power, faults, swing, heater and restriction bits follow the reference and inspected CCM15 web interface. Unknown codes remain unknown.

Version 0.1.11 also reads query-free setting.xml and roomset.xml for candidate verification, configured names and whitelisted non-secret gateway information. These endpoints support vendor configuration writes with parameters; this metadata transport refuses all query parameters and ctrl.xml. See [Discovery and metadata](DISCOVERY_AND_METADATA.md).

These verified fields do not provide a reliable indoor model or duct/split
identifier. Indoor type is explicitly configured by the user; names, display
groups and swing state are not used to infer it. See [Indoor types and
icons](PUBLIC_SETUP.md#indoor-types-and-icons).

The inspected firmware's effective-power rule additionally forces Off when byte 3 bit 0 is clear. Raw reported mode code is retained separately. Differential testing checks 2,792 payloads against the upstream decoder, with the documented effective-power and Celsius conversion adaptations.

## Writes and read-back

Climate control uses GET ctrl.xml with the addressed indoor and a complete mode/fan/target request. Each request uses freshly read state to preserve unaffected settings. Configured standard firmware compatibility also supplies the reported sw/ht bits. Restriction requests use the separate lock/value format and do not include climate fields. The numeric password transform follows the upstream reference; transport remains local HTTP.

Control responses 200/302 are accepted as transport responses, never as proof of application. The app follows no redirect and never automatically repeats a physical control request. It verifies status.xml after dispatch, up to nine reads with a 30-second confirmation budget plus transport and queue time.

Observed MI2 power Off can disable operational swing and report a stopped fan even though those parameters were retained on the wire. These exceptions apply only when the requested and observed mode is Off; target, heater and active mode/fan remain strictly checked. Enabling swing while Off and explicitly requesting Fan Off while active are rejected before writing.

Cool/Heat mode locks, Low/Medium/High fan locks, lower cooling and upper heating setpoints, and wireless remote control lock follow the local firmware options and the reference. Inactive temperature limits are null in numeric tags and No limit in the readable status. Inactive mode/fan restriction bits mean Unlocked regardless of stale value bits. No guessed full-keyboard lock command is implemented. [Midea's WDC-86E/KD manual](https://www.midea.es/wp-content/uploads/2018/07/MI-MU_M_CTR_WDC-86E-KD-ES.pdf#page=23) distinguishes the wireless remote from the wired thermostat.

## Scope

The tested gateway's reported name starts with `DZ230327V03`, confirmed by a
query-free settings read on 11 October 2026 (local time), with nine populated
indoor slots in status.xml. The owner reports that the gateway did not detect
the connected MI2 indoors before a CCM15 firmware update. The previous build
and the exact flashed firmware file/version are unknown. This observation is
not a tested minimum-version rule or proof that other firmware is incompatible.
Homey can import only indoors that the gateway already exposes.

The owner's programming photograph shows PICkit 3's Firmware Suite Version
`01.26.81` and successful programming/verification. Microchip identifies this
field as the debugger firmware suite version in its
[PICkit 3 User's Guide, section 10.5.4](https://ww1.microchip.com/downloads/en/devicedoc/51795b.pdf#page=66).
It does not identify the flashed CCM15 application firmware. No firmware image
is supplied with this Homey app and it does not flash the gateway.

Actual hardware testing covers one CCM15 with nine MI2 indoors on one V6i heat-pump outdoor, including two wall splits and seven ducts, through Homey Pro Early 2023. Group membership must be configured from the real refrigerant topology. Heat against Cool/Dry/Fan and independent Auto are blocked under the shared heat-pump policy. The gateway does not supply that topology or outdoor-priority configuration automatically.

The protocol provides no verified humidity, air quality, occupancy, consumption or outdoor temperature fields. Room temperature is reported by the indoor, not an independent room sensor. Fault display encoding is retained without inventing a technical fault diagnosis. Fahrenheit readings are converted to Celsius, while Fahrenheit control is blocked until hardware validation. Auxiliary electric heater control requires confirmed hardware and was not tested on this installation.

## Gateway discovery and names

Version 0.1.11 adds verified gateway discovery, bounded local address search, configured indoor names and read-only gateway information. Existing devices keep their names, identities, profiles and Flows. See [DISCOVERY_AND_METADATA.md](DISCOVERY_AND_METADATA.md).
