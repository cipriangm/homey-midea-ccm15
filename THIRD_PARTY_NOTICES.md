# Third party attribution

The CCM15 byte decoding and HTTP command generation are a JavaScript adaptation
of HomeOps/py-ccm15, pinned to commit
`4dc5c8df0531541a47be3bcb7ad33b57b7665f6f` (2026-07-04).
Its MIT license and copyright notice are retained in `LICENSE` and `docs/reference/LICENSE`.
The original reverse engineering is credited in the upstream PROTOCOL.md.
The accepted HTTP 200/302 command responses follow CCM15Device.async_send_state;
the local implementation never follows a redirect and confirms state by reading.
The effective power bit rule additionally follows the inspected local gateway
firmware, as documented in docs/PUBLIC_PROTOCOL_NOTES.md.

Source: https://github.com/HomeOps/py-ccm15/tree/4dc5c8df0531541a47be3bcb7ad33b57b7665f6f

Homey SDK is provided by Athom at runtime. Homey CLI and its development-only
dependencies live under `.tools/`; they are not bundled into the installed app.

The five lock/unlock request formats, active restriction labels, return-code
observations and gateway error labels additionally follow the local midea.js
firmware inspected as text. The proprietary firmware is not redistributed.

The Midea app icon is a monochrome SVG derived from the official
Midea Free Logo Black RGB vector provided at
https://www.mideacomfortna.ca/forpros.html (Midea Logos download).
The Midea mark remains the property of Midea; it is not included in the
MIT license grant for this integration. Use identifies supported equipment
and does not imply an official Midea app or endorsement.

The app cover is the official Midea lifestyle photograph recommended by the
Athom reviewer, downloaded from Midea's web-res.midea.com brand site. The
driver product photo is from Midea's official MBT VRF MI2 medium static
pressure duct page; see docs/STORE_ASSETS.md for exact source links.
Midea retains rights to those brand/product assets, which are outside the
MIT license grant for the integration code.
