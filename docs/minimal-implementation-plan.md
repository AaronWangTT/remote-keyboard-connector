# Minimal Remote Keyboard Implementation Plan

Date: 2026-09-14

Historical milestone: the single-key interface and fixed-command protocol below
have been superseded by the [keyboard enhancement](keyboard-enhancement-plan.md).
Use that plan for the current layout, JSON protocol, and test results.

This is the first implementation increment. The broader
[design specification](remote-keyboard-design.md) remains the later product
target; this plan deliberately narrows it to the scope below.

## Scope

| Requirement | This increment |
| --- | --- |
| REQ-01 | ESP32-S3 native USB, one boot-keyboard interface, no report ID, eight-byte reports. Send only the A usage or all keys up. |
| REQ-02 | Start directly in standalone AP mode. A controller joins the board's network. No station mode, scanning, provisioning page, or stored network configuration. |
| REQ-03 | Serve the embedded page and input WebSocket at the AP address, `http://192.168.4.1/`. No Internet or external assets. |
| REQ-04 | One on-screen `a` key, usable by mouse, touch, and the controller's physical A key while the keyboard surface is focused. |
| REQ-05 | Forward presses and releases in order to USB. No login, sessions, authorization, or controller lease protocol in this prototype. |

Use a clearly documented, build-time development AP password. It is not owner
authentication or a production secret. Anyone with AP access can send input;
use only on an isolated test network with an authorized, non-sensitive USB host.
Do not deploy this unauthenticated HTTP/WS prototype as the operational product.

No extra keys, modifier forwarding, Wi-Fi configuration, persistence, TLS,
authentication, text injection, or other product features are included. The A
usage represents a physical US ANSI key; the USB host's layout and Caps Lock
determine the resulting character. Mouse input operates the on-screen key and
does not emulate a USB mouse.

Retain only the safety needed for this input path: no typing on connection,
bounded ordered reports, neutral state on USB recovery, release on disconnect or
focus loss, and a device-side timeout if a controller disappears while holding
the key. Host auto-repeat owns holds; browser repeat events do not create taps.

## Phases And Gates

Advance only after the current phase's automated checks and ESP-IDF build pass.
Record hardware-only checks separately as pending, never as implied by a build.
Do not flash until native USB wiring, flash capacity, power, and a ROM recovery
path have been verified for this board.

### Phase 1: USB Keyboard

- Pin a compatible `esp_tinyusb` component and retain its generated dependency
  lock. Implement the keyboard descriptor and a serialized, bounded A/up report
  path using TinyUSB readiness and completion callbacks.
- Start and recover with all keys up. No automatic demonstration keystrokes.
- Validate report bytes, ordering, overflow/disconnect cleanup, and timeout
  behavior with focused host-side tests and USB fakes; build for ESP32-S3.
- Hardware acceptance, pending board access: enumerate as a keyboard on one
  desktop host, inspect the descriptor, and confirm the recovery/logging path.

Status: automated gate passed on 2026-09-14; hardware acceptance pending.

- `bash tools/test-host.sh`: six tests passed with address/undefined-behavior
  sanitizers, including actual descriptor/report checks, 1,000 ordered taps,
  overflow, stale generations, deadlines, failed submissions, and USB recovery.
- `idf.py build`: passed with ESP-IDF v6.1, `esp_tinyusb 2.0.1~1`, and the
  generated lock pinning TinyUSB `0.21.0~1`. Phase-1 image: `0x2fe60` bytes.
- The configured USB descriptor requests up to 500 mA and disables remote
  wakeup. Actual consumption, pre-configuration/suspend limits, and the
  component's development VID/PID remain hardware/distribution gates.

### Phase 2: Default AP And Web Page

- Initialize only the NVS support required by Wi-Fi; do not erase it on errors.
  Start a WPA2 development AP with a device-specific SSID suffix, DHCP, and a
  fixed AP address. No client Wi-Fi configuration step.
- Embed a small dependency-free HTML/CSS/JavaScript page with one `a` key and
  connection/USB state. Keep the key disabled when USB is unavailable.
- Validate the ESP-IDF build and embedded routes/assets. Test the page at desktop
  and phone sizes with no external asset requests.
- Hardware acceptance, pending board access: join the AP and load the page
  without a router or Internet connection.

Status: automated gate passed on 2026-09-14; radio acceptance pending.

- `idf.py build`: passed; phase-2 image `0xcf2e0` bytes, fitting the existing
  default application partition with 19% free. The board's flash remains
  unverified, and this is not the broader product's resource-budget signoff.
- JavaScript syntax checks and editor diagnostics passed.
- Browser automation checked 1366x768, 375x667, and 667x375: no horizontal
  overflow or overlapping controls, key targets above 44 pixels, no external
  asset requests, and correct enabled/disabled behavior for mocked USB status.
  Desktop and phone screenshots were inspected.
- AP defaults: `WiFiKeyboard-<last-six-MAC-hex-digits>`, development password
  `a-key-test-only`, channel 1, one associated controller, `192.168.4.1/24`.
  NVS initialization does not erase existing contents; Wi-Fi settings use RAM.

### Phase 3: Single-Key Input

- Connect a bounded WebSocket state protocol to the same USB report path. Permit
  one input socket at a time without adding login or lease acquisition.
- Merge physical A, mouse, and touch holds so releasing one source cannot
  release another source's hold. Use pointer capture, ignore keyboard repeats,
  and keep input in editable fields and browser-reserved shortcuts local.
- Send complete A/up states in order. Heartbeats maintain a one-second device
  safety deadline; disconnect, cancellation, overload, and USB loss clear input.
  Reconnect starts released and never replays input.
- Validate parser and safety failures, rapid press/release ordering, physical
  keyboard input, mouse/touch input, mixed input, and focus-loss cleanup with
  focused automated tests. Rebuild the complete firmware.
- Hardware acceptance, pending board access: in a consenting test host's text
  editor, verify A/up for all three input methods, held-key repeat, rapid taps,
  browser/network loss, and unplug/replug without stale input. Record actual
  USB reports and timing. Other target hosts remain unverified until tested.

Status: automated gate passed on 2026-09-14; real browser-to-USB acceptance pending.

- `bash tools/test-host.sh`: six USB state/descriptor tests, bounded protocol
  checks, and eight browser event tests passed. The C checks use address and
  undefined-behavior sanitizers; C and JavaScript tests each cover 1,000 taps.
- `npm --prefix tools test`: four integration tests passed. A real headless
  Chromium run sent one physical-A tap, one mouse click, and one touch tap;
  the mock recorded exactly three `down`, three `up`, and six `queued` replies.
  Mixed keyboard/mouse holds, two-touch cancellation, editable-field focus,
  navigation, and socket loss also passed. No focus/visibility guards were
  disabled for these tests.
- Desktop and phone screenshots passed the layout checks and were inspected.
  Native tap highlighting is disabled on the key so it does not obscure the
  explicit pressed/released state. No external asset requests were observed.
- Final `idf.py build`: passed; image `0xd2600` bytes with `0x2da00` bytes
  (18%) free in the existing default application partition. No flash operation
  was performed and no board-specific flash/PSRAM settings were added.

## Minimal Wire Protocol

This prototype uses `/api/v1/keyboard` with fixed, case-sensitive text commands,
not the broader product's JSON/lease protocol. A frame must be final and contain
one command of at most four bytes. Binary, fragmented, oversized, and unknown
messages close the owning socket and clear its input.

| Command | Action and reply |
| --- | --- |
| `down` | Enqueue A pressed; reply `queued`. |
| `up` | Enqueue all keys up; reply `queued`. |
| `ping` | Refresh liveness; reply `ready` or `waiting` for USB. |
| `stop` | Prioritize release and close the input connection. |

`queued` confirms acceptance, not USB completion or a character appearing on the
host. The firmware still serializes reports through transfer completion. The
browser sends `ping` every 250 ms, limits unacknowledged states to 16, and closes
on excess buffering or missing replies. Firmware release does not depend on a
working browser or HTTP reply. The first socket uses input automatically when
USB is ready; a second live input socket is rejected. There is no login or
explicit acquisition operation in this increment.

## Running The Checks

Build once with ESP-IDF v6.1 to obtain the locked managed components. The host
tests require a Linux C compiler and Node.js 22 or later. Browser testing uses
development-only packages; the embedded application has no npm runtime dependency.

```bash
bash tools/test-host.sh
npm ci --prefix tools --ignore-scripts
npm exec --prefix tools -- playwright install chromium --only-shell
npm --prefix tools test
```

Chromium also requires its Linux runtime libraries. In this WSL installation,
`libnspr4`, `libnss3`, and `libasound2t64` were missing. Their Ubuntu packages were
downloaded and unpacked without elevated privileges into `.cache/browser-libs`.
For that existing local-cache setup, run the browser tests with:

```bash
LD_LIBRARY_PATH="$PWD/.cache/browser-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  npm --prefix tools test
```

On other machines, install the normal Playwright browser dependencies through
the approved local setup process. Screenshots are generated under `.cache/tests`.
The integration suite starts isolated loopback servers on available ports and
stops them after testing. The VS Code shared browser may be hidden while editing;
that correctly disables input and is not a reason to remove the safety guards.

## Preview And Receipt Counters

`npm --prefix tools run preview` serves the page at `http://127.0.0.1:8080/` with
mocked USB readiness. Set `PORT` to choose another port, or `PREVIEW_USB_READY=0`
to exercise the waiting state. No keystrokes leave the mock server.

`GET /__test__/input` on that preview reports aggregate `down`, `up`, `stop`,
`queued`, and `forced_release` counts plus current `connected` and `pressed`
flags. Compare counts before and after an action to confirm backend receipt;
one tap should add one `down`, one `up`, and two `queued` replies. Ctrl+C prints
the aggregate receipt summary before shutdown. Counters reset with the process;
there is no raw message history. These diagnostics exist only in the host preview
and are not embedded in the firmware.

## Completion Record

All three automated phase gates passed in order for this historical single-A
milestone. At that point, physical acceptance was pending; the phase results
above retain that original scope and status.

Subsequent hardware confirmation, 2026-09-14: after the
[keyboard enhancement](keyboard-enhancement-plan.md), the user reported successful
flashing and operation with both the separate-image ZIP and merged BIN. Both
formats have a user-reported board smoke-test pass, recorded in the
[hardware test log](../hardware/README.md#hardware-test-status). This confirmation
applies to the enhanced firmware, not a separately tested single-A image.

Detailed key/input-method results, USB report capture and release timing,
power/suspend limits, recovery, endurance, and the host/controller compatibility
matrix remain to be recorded. The broader design's 20% partition headroom and
operational security targets are not signed off by a basic board smoke test.