# Midea CCM15 — setup and use

This Homey Apps SDK v3 app connects Homey Pro directly to the local HTTP
interface of a Midea CCM15 VRF gateway. Home Assistant and Midea cloud accounts
are not required. It is an independent community integration.

## Gateway firmware compatibility

On the tested MI2/V6i installation, the owner reports that CCM15 could not
detect the connected indoor units until its firmware was updated. After the
update, the gateway exposes all nine indoors and its reported name starts with
`DZ230327V03`. This is the label of the tested gateway; the exact flashed
firmware file and the previous version have not been identified. It does not
establish a minimum version or show that every other CCM15 firmware is incompatible.

CCM15 must first detect the indoors in its own interface and expose populated
slots in `status.xml`; Homey imports those slots. If the gateway itself cannot
see the connected equipment, ask your Midea installer about the appropriate
gateway firmware for that installation. The Homey app does not update CCM15
firmware. See [Protocol and firmware scope](PUBLIC_PROTOCOL_NOTES.md).

## Pairing

1. Reserve the gateway address in DHCP and allow Homey to reach its HTTP port.
2. Add **Midea → Midea CCM15 indoor unit → Find gateways**. Select a verified
   gateway. If needed, use Search options to edit the local range or run a full
   search of one private /24–/32 block. Manual address and HTTP port are available.
3. The app reuses an existing gateway identity when recognized, otherwise uses
   an available MAC or a host/port fallback. An explicit stable identifier is
   optional. Keep this identity when adding more indoors or changing the IP.
4. Select the discovered indoor addresses. Each populated slot becomes one
   Homey device; empty slots and devices already paired with that identity are
   omitted by Homey. If all indoors are already added, the app says so and offers
   Close. Otherwise the native list offers the remaining indoors; Previous lets
   you return to gateway selection. Pairing only reads the gateway and starts
   with control off.
5. Configured CCM15 indoor names are proposed by default; opt out for generic
   names. You can rename each indoor and place it in its Homey zone. Existing
   paired names and control profiles are preserved.

The editable default search range is a /24 suggestion, not a detected network
mask. MAC discovery is a candidate filter and may be unavailable across VLANs;
HTTP verification, bounded address search and manual entry remain supported.
See [Discovery and metadata](DISCOVERY_AND_METADATA.md) for identity and scope.

The App Store name is **Midea** from version 0.1.13; its supported gateway
remains **CCM15**. Contact [app support](mailto:legaturi.ace7b@icloud.com) for
questions or bug reports. Earlier installed versions may still display the
app name Midea CCM15 until they are updated.

## Indoor types and icons

Open the indoor device, select the settings gear, then **Advanced Settings →
Indoor unit type**. New devices begin with **Not configured**; choose the
actual hardware:

- **Ducted — no swing control** for a ducted indoor.
- **Wall split — swing control** for a wall-mounted split.

The verified CCM15 HTTP fields do not identify an indoor's model or duct/split
type reliably. The app therefore uses this explicit setting rather than
inferring hardware from its name, display group or current swing state. This
setting determines whether the Swing capability is available. Swing is
available only for wall splits while running; turn the indoor on before
enabling it. Fan Off is a reported stopped state; use power Off to stop a
running indoor.

The icon is a separate native Homey preference. In the device's **Settings →
Icon**, keep the wall-mounted air conditioner icon for a split or choose a
rectangular grille symbol from **Climate** for a ducted indoor. Version 0.1.12 does
not automatically change the icon when the indoor type changes. Existing
devices can be given different icons without deleting or re-pairing them.
See [Homey's custom device icons](https://homey.app/en-us/news/new-custom-device-icons-status-indicators/).

## Enable control

Keep auxiliary electric heater support off unless that separate hardware is
confirmed. Ordinary VRF heating does not require that switch.

Select the gateway control compatibility that matches the firmware. Standard
CCM15 uses complete climate requests and explicitly preserves the reported
swing and auxiliary heater bits. Selecting this compatibility does not declare
that either type of hardware is present. The default unverified choice blocks
climate control until configured.

For a shared heat-pump outdoor unit, configure **Shared VRF heat pump** and
list every indoor address on that outdoor, for example `a0,a1,a2`. Use the
same group membership on each of those devices. The app refuses opposing
Heat and Cool/Dry/Fan requests and independent Auto for this policy. It does
not discover refrigerant circuits or change outdoor priority automatically.
For separate outdoor units, enter the actual group for each device; do not put
all gateway addresses into one group unless they share that outdoor.

If this firmware requires a numeric control password, enter it in device
settings. The app applies the firmware's documented wire transform. Finally,
enable **Enable device control**. A gateway password is carried over local HTTP;
the app does not turn the CCM15 interface into an encrypted service.

## Removing and re-adding one indoor

With the same gateway identity, pairing omits existing indoor devices. If one
indoor was deleted and the other indoors remain paired, the native list offers
only that missing indoor. No changes to the other devices are required.

Before removing a device, record its Homey name, exact zone, gateway identity,
indoor slot and hardware/control settings. Version 0.1.12 does not retain a
removed device's custom name or zone automatically: pairing proposes the CCM15
name (or generic slot name) and Homey's current pairing zone. Restore the saved
name/zone after adding, configure the actual hardware and only then enable
control. The newly added device has a new internal Homey device ID even when
its CCM15 slot identity is unchanged; check device references in dependent
Flows. Re-pairing is not a restore of Homey history or Flow bindings.

## Controls and readings

The device provides power, target temperature in whole degrees from 17–30°C,
operating mode and fan speed. On resumes the last active mode observed by
Homey, or the configured first start mode if none was observed. Temperature
changes on an Off unit keep it Off. Unchanged climate settings are taken from
a fresh gateway read before each command. On power Off the indoor may report
its fan stopped and swing disabled even though both parameters were preserved
in the request. Confirmation accepts these stopped states only while the
reported operating mode is Off; running speeds, target and heater remain
strictly checked.

Cooling lower limits, heating upper limits, Cool/Heat restrictions, fan
restrictions and wireless remote control lock have controls and explicit
reported status. **No limit** and **Unlocked** describe inactive restrictions;
numeric limit Flow tags remain empty when inactive. A truly unrecognized
reported value remains visible instead of being silently treated as unlocked.

Wireless remote control lock is a restriction on the infrared remote. It does
not promise to disable every key on a wired wall thermostat. The WDC-86E/KD
manual distinguishes these restrictions and uses a shared lock indicator.

Room temperature is the indoor's reported temperature. The verified protocol
does not supply humidity, CO₂, VOC, occupancy, electricity consumption or
outdoor temperature. Fault labels follow the controller's display encoding;
they are not a diagnosis of the equipment.

Homey's native Power usage when on/off fields are nominal user estimates,
not CCM15 measurements. Saving the native settings screen was observed to
normalize blank estimates to 0 W on the tested Homey version. Such a zero
does not mean the indoor's actual power consumption is zero.

Advanced settings also show five read-only information fields: gateway reported
name, network configuration, available MAC identifier, configured indoor name
and gateway display groups. A gateway display group is not an inferred Homey
zone or refrigerant circuit. Optional information refreshes approximately every
ten minutes; failures retry after one minute while successful values are retained.

## Flows

Use the app's **Set temperature** action to change the target from a Flow.
**Set climate** applies mode, fan and temperature together. Additional actions
control power, mode, fan, optional swing/heater, restrictions, both temperature
limits, remote lock and status refresh.

Examples using the cards for one selected indoor:

- **When** a schedule starts, **And** the unit is connected, **Then** Set climate
  to Cool, Auto and 24°C.
- **When** you leave, **Then** Set power Off.
- **When** the target schedule changes, **Then** Set temperature to 25°C.
- **When** Command result is received, use the Result, Detail and Command ID
  tags to notify about a rejected or unconfirmed request.

The app's custom control actions await state confirmation. Standard Homey
capability actions use the same selection queue as the native controls and
acknowledge admission first. For sequences that depend on confirmed state,
use the custom actions and the **Reported** temperature/mode/fan/power tags.

Conditions include connection, reported mode/fan, fault, measured temperature
above a threshold and active restriction. Conditions refuse stale values when
disconnected. Homey may reject device cards before the app listener when the
device is unavailable. To notify about disconnection, use Connection changed
and its Connected token in a Logic condition instead of calling that
unavailable device’s connection condition. Triggers include state, connection, mode, fan, fault and command
result changes. Avoid a Flow that continually reacts to its own command result
by sending the same command again.

## Timing and errors

Gateway polling is shared every 15 seconds. Native controls wait for one second
without a new edit before sending the final choice; incoming readings do not
reset a selector while its edit is being confirmed. Custom selectors can still
advertise diagnostic fallback entries or Fan Off on some Homey builds; an
unsupported selection is refused before any physical request. The normal
reported status distinguishes No limit, Unlocked and unrecognized states.

Each command is dispatched once. The app takes up to nine confirmation reads
with a 30-second budget after dispatch response, plus any queue/transport time.
Observed CCM15 state updates can exceed 20 seconds. An HTTP 200/302 response
alone is not confirmation, and redirects are never followed.

If confirmation fails, check **Last command result**, **Command detail** and
the Reported values before issuing another command: the first one may already
have taken effect. A later matching read can clear the latest unconfirmed
warning within an additional 60 seconds. It never resends the request and
does not rerun an already failed Flow action.

On a failed status read or absent slot the device becomes unavailable and
Connected is false; old sensor values remain with their last successful read
time. Fahrenheit readings are converted to Celsius, but Fahrenheit control is
blocked until tested on that hardware.

## Local developer installation

Install the official Homey CLI and sign in yourself with `homey login`.
Use `homey select` and verify the selected hub with `homey select current --json`
before installing. From the app directory run:

```sh
homey app validate --level publish
homey app install
```

`app install` is a local developer installation. It does not publish the app in
the Homey App Store. Keep existing device settings; a clean installation is
unnecessary for normal updates.

Offline tests use `node --test tests/*.test.js`. Protocol differential checks
use `python3 scripts/check-reference.py` with Node on PATH. Read-only gateway
inspection uses `node scripts/read-status.js GATEWAY_HOST [PORT]`.

## Sources and scope

- [HomeOps/py-ccm15](https://github.com/HomeOps/py-ccm15), MIT, retained commit
  `4dc5c8df0531541a47be3bcb7ad33b57b7665f6f`.
- [Homey Apps SDK](https://apps.developer.homey.app/).
- [Midea WDC-86E/KD manual](https://www.midea.es/wp-content/uploads/2018/07/MI-MU_M_CTR_WDC-86E-KD-ES.pdf#page=23).

The CCM15 HTTP interface is reverse engineered, and firmware differences are
possible. Real testing covers a CCM15 with nine MI2 indoors on a V6i outdoor,
including wall splits and ducts. It does not establish compatibility with
every Midea controller, older Homey hardware or Homey Cloud/Bridge.
