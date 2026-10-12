# Gateway discovery and configured information — v0.1.12

## Pairing

Choose Add device → Midea → Midea CCM15 indoor unit → Find gateways. The quick search first checks saved gateway addresses and Homey MAC discovery candidates. Each candidate must return valid CCM15 status plus recognized gateway settings or room settings. A filename or HTTP 200 response alone is insufficient. If quick discovery finds nothing, the selected local address range is searched. Search options also offers a full-range search when a second gateway or a different hardware family is present. Results can be selected before the scan finishes.

The suggested range is an editable /24 block, taken from a saved gateway address when available, otherwise from Homey's local address. It is a suggestion, not a measurement of the subnet mask. A search accepts one private IPv4 /24–/32 block at a time, with at most 254 usable addresses, four concurrent probes and a 70-second scheduling budget. The HTTP status probe has an 800 ms timeout; optional information reads have a 1.5-second timeout. Active reads can take briefly beyond the scheduling deadline to settle. Network and broadcast addresses are omitted for /24–/30. RFC1918 ranges only: no public addresses, link-local, multicast, loopback or whole /16 scans.

Stop searching, choosing a gateway, replacing a search or closing the pairing session cancels the scan. Search admission returns immediately; progress uses separate pairing events, avoiding Homey's short callback timeout. No device is added automatically. Select the indoor units to add in Homey's standard device list. If every populated indoor for this identity is already paired, a clear completion message and Close button are shown. Otherwise, only unpaired indoors are offered. Previous returns to gateway selection; no new device is created until the user chooses indoors and continues.

Manual IP/hostname and a configurable HTTP port remain available. If the gateway is on another routed network/VLAN, edit the search range or use its address. MAC discovery and ARP may be unavailable across routed networks.

## Candidate filtering and identity

The native Homey strategy uses the observed hardware-family prefix 00:04:A3. This is a chipset-family candidate filter, not a universal Midea identifier or proof of CCM15. Other hardware families remain supported through the bounded HTTP scan and manual entry. No undocumented mDNS, SSDP or proprietary UDP messages are invented.

Actual MAC addresses, when ARP makes them available, provide stable identities for new gateways. Existing gateway identities are reused by verified MAC or unchanged host/port, preserving indoor IDs and Flows. Conflicting saved identities are refused. If the MAC at an already saved IP changes, pairing asks the user to check identity instead of silently claiming it is the same equipment.

When ARP is unavailable, a new gateway receives a deterministic host/port-based fallback identifier, or a user-supplied stable identifier. This fallback cannot independently track an IP change. Edit the gateway address in existing device settings when an IP changes; pairing does not silently migrate existing device addresses. Existing Homey names are never renamed from CCM15, and existing indoor types, control permissions and VRF group settings are retained.

## Readable information

Configured indoor names are read from roomset.xml and proposed as device names during pairing. The user can opt out. Only names for truly populated status slots become devices. Missing/default names use Midea aN. Gateway display groups are shown as read-only information; they do not create Homey zones or infer shared outdoor/refrigerant topology.

Five read-only fields appear in device Advanced settings: Gateway reported name, Gateway network information, Gateway network identifier, Indoor name in CCM15, and CCM15 display groups. The reported name may be firmware/version/counter text rather than a friendly device name. The port field inside setting.xml is not assumed to be the HTTP port.

Information is shared by all indoors on a gateway, refreshed at startup and then approximately every ten minutes. Missing optional information is retried after one minute; previous successful information is retained during transient failures. Status polling and confirmed control remain separate. Read-only Homey labels do not call onSettings or alter climate controls.

## Verified format and boundaries

This installation's midea.js get_roomset_ret concatenates rs0–rs15; toLocalRoomSet decodes 15 display-group triples (name, unsigned low/high address masks) followed by 64 indoor labels. Slots 31, 32 and 63 are tested explicitly. get_config reads name, ip, netmask, gateway and dhcp. The deployed firmware declares GB2312; the reader decodes it with TextDecoder rather than corrupting labels. UTF-8 and bounded gzip decoding are also tested. XML is limited to 64 KiB, strict response/flat-field structure, no DTD or external entities, and no redirects. Gateway text is rendered with textContent.

Only query-free GET /status.xml, /setting.xml and /roomset.xml are permitted by the discovery transport. The latter two endpoints also implement writes when query parameters are supplied; discovery never supplies those parameters. No ctrl.xml request is possible through this transport. A password and cloud information may occur in a settings response, but only whitelisted non-secret information is retained; passwords/cloud IDs are never imported, logged or used automatically.

No model type, refrigerant topology, humidity, air-quality, occupancy or energy reading is inferred from these fields. Hardware/control profiles still require real installation information.

## References

- [Homey discovery](https://apps.developer.homey.app/wireless/wi-fi/discovery)
- [Homey ARP manager](https://apps-sdk-v3.developer.homey.app/ManagerArp.html)
- [Homey local address API](https://apps-sdk-v3.developer.homey.app/ManagerCloud.html#getLocalAddress)
- [Homey read-only settings labels](https://apps.developer.homey.app/the-basics/devices/settings)
- [Midea CCM15 manual, local discovery](https://www.midea.es/wp-content/uploads/2018/05/MU_M_CTR_CE-CCM15_CCM15A-N-E-ES.pdf#page=19)
- [Protocol reference](https://github.com/HomeOps/py-ccm15/blob/main/PROTOCOL.md)

The vendor firmware is inspected as text and is not redistributed.

## Pairing navigation verification in v0.1.12

The custom page scopes its own helpers and does not replace the Homey framework's global jQuery or view helpers. Regression tests execute the page and framework navigation in the same global context, including view re-entry. Real Homey Web checks covered a fully paired physical gateway, a new read-only HTTP fixture with nine candidate indoors, Previous/re-entry, addition of one fixture indoor with control disabled, and pairing again with only the remaining eight offered. The fixture device was removed afterward. The owner confirmed the fully paired completion and Close on iPhone. Other mobile OS/browser combinations are not claimed.
