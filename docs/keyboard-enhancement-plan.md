# iPhone-First Keyboard Enhancement Plan

Date: 2026-09-14

Historical keyboard-only increment: networking, authentication, provisioning,
and firmware-distribution statements below describe the implementation at that
time. They are superseded by the [Wi-Fi enhancement plan](wifi-enhancement-plan.md)
and [current README](../README.md). The typing layout and input-safety design
remain relevant; the old unauthenticated AP is not the current firmware default.
The later Globe input-source and Cancel/Escape increment is specified and
recorded in the [remote keyboard design](remote-keyboard-design.md#input-source-and-cancel-layout).

This increment expands the [single-key prototype](minimal-implementation-plan.md).
The user selected English (US) iPhone-style typing keys without a computer-key
panel. Default AP mode, unauthenticated HTTP/WebSocket access, and one controller
remain unchanged. This is a custom web keyboard, not the native iOS keyboard.

## Agreed Scope

- QWERTY letters, `123` number/punctuation and `#+=` symbol pages, covering
  printable US-ANSI characters plus Backspace, Space, Return, and Shift/Caps Lock.
- Held and one-shot Shift; double-tap Shift requests Caps Lock. Actual host LED
  feedback controls the Caps indicator, with unknown/pending states where needed.
- Physical typing keys and left/right Shift work while the keyboard surface is
  focused. Ctrl/Alt/Command shortcuts, unsupported keys, composition, and input
  in other controls stay local. No navigation or function-key panel is added.
- Merge physical, mouse, and touch holds; preserve ordered complete reports,
  host auto-repeat, bounded queues, timeout release, and neutral USB recovery.
- iPhone portrait first, then landscape, iPad, PC, and Mac viewports. The user
  approved iPhone-style letter widths (approximately 28-38 CSS pixels on narrow
  phones) instead of the broader design's 44-pixel minimum width. Heights remain
  at least 44 pixels. Fit ten QWERTY keys without horizontal scrolling, preserve
  stable dimensions, respect safe areas, and avoid overlapping controls.

No Wi-Fi provisioning, authorization, TLS, firmware updates, mouse emulation,
extra languages, emoji, dictation, prediction/autocorrect, swipe typing, accented
long-press menus, or arbitrary Unicode injection. Symbols are US-ANSI rather
than iPhone currency/bullet characters that cannot be produced portably through
this HID layout. The USB host's layout and lock behavior determine actual text.

## Phase Gates

Complete each phase's focused tests and ESP-IDF build before the next. Record
measured results, not assumed success. Do not flash until board wiring, flash
capacity, power, and recovery have been verified.

### Phase 1: Multi-Key USB State

Replace the A/up boolean with a validated modifier bitmap and up to six unique
typing-key usages. Use TinyUSB HID definitions; keep the eight-byte boot report
without a report ID. Retain the existing ordered FIFO, generation checks,
priority release, and deadlines. Expose host Caps Lock LED feedback. Keep a
temporary A/up adapter until the client/protocol migration is complete.

Gate: native C tests for report bytes, Shift chords, ordering, six-key capacity,
invalid states, timeout and USB recovery, followed by an ESP32-S3 build.

Status: automated gate passed on 2026-09-14. Eight native tests passed with
sanitizers, including exhaustive byte-sized usage/modifier validation and 1,000
ordered Shift chords. Existing single-A client tests still pass through the
temporary adapter. ESP-IDF build passed; phase-1 image `0xd27a0` bytes. Caps Lock
LED handling compiles; actual host output reports remain a hardware check.

### Phase 2: Full-State Transport

Replace fixed A/up commands with bounded versioned JSON parsed by pinned cJSON.
Validate schema, nesting, integers, supported keys/modifiers, and duplicates.
Update the existing one-key page and mock together before expanding its layout.
Keep `queued` acknowledgements explicitly distinct from USB completion. Status
carries USB readiness and Caps Lock feedback. No key payloads in firmware logs.

Gate: parser/state tests, updated client/mock receipt tests, and firmware build.

Status: automated gate passed on 2026-09-14. Native JSON/schema and report tests,
eight interim browser event tests, and four live-browser/WebSocket integration
tests passed. The locked cJSON 1.7.19 build uses a nesting limit of four and
256-byte frames. Ordered state sequences and Caps Lock status are wired through
the firmware and mock. Phase-2 firmware image: `0xd4050` bytes (17% free).

### Phase 3: iPhone Typing Surface

Add an explicit US-ANSI key map and letter/number/symbol layouts. Extend the
dependency-free page with per-source holds, Shift latching/consumption, Caps
requests/feedback, page switching, and scoped physical-key handling. Embed only
the required library icon assets; no CDN or runtime framework. Page changes and
cancellation must not leave hidden keys held. Provide a visible release control.

Gate: layout/map and input-model tests, real-browser keyboard/mouse/multi-touch
delivery and cancellation checks, plus firmware build with the full page.

Status: automated gate passed on 2026-09-14. Twelve model/layout tests and seven
real Chromium/WebSocket integration tests passed. Coverage includes all printable
US-ANSI mappings, one-shot and held Shift, host-confirmed and unknown Caps Lock,
symbols, Backspace/Space/Return, multi-touch, page-change cleanup, and six-key
overflow. Five pinned Lucide icons are embedded locally with their license.
The firmware builds at `0xd7ec0` bytes with 16% application-partition space free.

### Phase 4: Responsive And Regression Validation

Check all pages at 320, 375, 390, and 430-pixel phone widths, phone landscape,
768/1024-pixel tablets, and desktop sizes. Inspect screenshots and key bounds;
test Shift/Caps, punctuation, mixed input, capacity overflow, reconnect, stalled
acknowledgements, and LED feedback. Confirm no external asset requests. Run all
native/browser tests and the final ESP-IDF build; record image size and partition
headroom without assuming larger flash or changing partition configuration.

Update README and preview instructions. Real iPhone/iPad Safari, physical USB
reports, radio behavior, power, and recovery remain separate hardware gates.

Status: automated gate passed on 2026-09-14.

- Eight native USB tests and the bounded JSON parser checks pass under address
  and undefined-behavior sanitizers. Twelve layout/input-model tests pass.
- All ten browser/backend integration tests pass: nine Chromium tests and one
  WebKit mobile-engine test. Both engines deliver touch and physical-key input
  to the actual loopback WebSocket mock without overriding focus guards.
- Chromium checks all three keyboard pages at 320x568, 375x667, 390x844,
  430x932, 568x320, 844x390, 768x1024, 1024x768, 1366x768, and 1920x1080.
  Key heights remain at least 44 pixels, phone letter widths at least 27 pixels
  (approximately 28 pixels on the narrowest row), with no scrolling, overlapping
  controls, or clipped labels. Portrait and landscape safe-area insets were
  also emulated and checked. Screenshots were inspected, including WebKit.
- Receipt tests verify Shift holds/latches, Caps confirmation and unknown state,
  punctuation pages, typing controls, mixed input, cancellation, page changes,
  disconnect, six-key overflow, dropped acknowledgements, excessive buffering,
  and send errors. No external assets or uncaught page errors were observed.
- Final ESP-IDF v6.1 build passes. Image: `0xd7ff0` bytes (884,720 bytes),
  leaving `0x28010` bytes (16%) in the existing application partition. Flash
  configuration and partition sizes are unchanged. This remains below the
  broader product's 20% headroom goal and is not an operational-release signoff.

## Typing Behavior

The main page uses iPhone-style QWERTY rows. `123`, `#+=`, and `ABC` switch
between letters, numbers, and symbols. These controls stay local; switching pages
clears active input rather than carrying hidden holds onto the new page.

Tap Shift for the next chord, hold it for simultaneous input, or double-tap it
within 300 ms to request Caps Lock. A single Shift tap while Caps is on requests
Caps off. The host's LED report determines `Caps on`/`Caps off`; a request shows
`Caps pending` and missing feedback remains unknown or at its last confirmed
state. No local uppercase toggle is presented as proof of a host lock change.

With Host set to Win, the on-screen Shift modifier is sent only alongside a
typing key. A tap of at most 400 ms still arms the next chord locally, or
requests Caps off when Caps is on, but never sends a standalone Shift tap.
This separates capitalization from Microsoft Pinyin's configurable Shift
Chinese/English mode toggle. An unused hold of at least 1000 ms sends one
standalone Left Shift tap on release and clears the local latch. An unused
hold between those thresholds does neither. Any other input during the hold,
another held input source, or cancellation prevents the IME gesture. Holding
Shift while typing remains a normal chord without an extra mode-switch tap.
The Shift key shows its held state even while its HID modifier is deferred;
that state is distinct from a one-shot latch after release. Changing Host clears
held input and local Shift gestures, publishing only a neutral release if needed.
The old hold cannot complete a gesture after the profile change. iOS-profile
and physical Shift key mappings are unchanged. Model and
Chromium/WebKit tests verify the emitted reports; actual Windows IME behavior
still requires device validation with the host's configured shortcuts.

Physical typing keys and left/right Shift use `KeyboardEvent.code`, so the USB
host must use the expected US-ANSI layout. Browser/OS shortcuts remain outside
the forwarding guarantee. Shift is a shared HID modifier: in a simultaneous
chord it affects every held key, including keys from other input sources. The
release button clears input immediately; reconnection never replays a hold.

## Full-State Protocol

The enhanced firmware and page replace the minimal fixed-command protocol.
Each WebSocket message is one JSON object, at most 256 bytes, with `v: 1`.
Only final text frames are accepted; binary and fragmented messages are rejected.
The parser requires exact fields, integer values, allowed typing usages, and no
duplicates. cJSON nesting is limited to four. Old `down`/`up` text commands are
no longer accepted.

| Message | Fields and meaning |
| --- | --- |
| `state` | `seq`, `modifiers`, `keys`: complete state, not text; `seq` starts at 1 per socket and increases without gaps. |
| `ping` | No additional fields; renew activity and request USB/Caps status. |
| `stop` | No additional fields; priority release and close the socket. |
| `queued` | Server reply with the accepted state's `seq`; confirms enqueueing only, not USB completion or host text rendering. |
| `status` | Server reply with `usb_ready` and `caps_lock` (`true`, `false`, or `null` when unknown). |

For example, Shift+A followed by release:

```json
{"v":1,"type":"state","seq":1,"modifiers":2,"keys":[4]}
```

```json
{"v":1,"type":"state","seq":2,"modifiers":0,"keys":[]}
```

Ordinary typing permits only left/right Shift modifier bits (`0x02` and `0x20`).
The later Globe/Cancel increment also permits only the exact single-Space states
Left Control+Space and Left GUI+Space, plus solitary unmodified Escape; arbitrary
Control/GUI/Escape combinations remain invalid. Up to six unique non-modifier
typing usages are normalized into the eight-byte USB report.
An invalid owner message, sequence gap/reuse, or overflow releases input and
closes the connection. The browser sends a heartbeat every 250 ms, bounds
outstanding states to 16, and disconnects on stalled acknowledgements or buffers.
The firmware retains its independent one-second input deadline and 250-ms report
age limit. No authentication, controller lease, or network setup is added.

## Follow-Up: Local Echo And Pointer

Decision recorded 2026-09-15, after the historical keyboard increment above and
the Wi-Fi and Globe/Cancel work. These are separate follow-up increments:

| Order | Feature | Scope |
| --- | --- | --- |
| 1 | Passive local echo | Implemented on `feature/keyboard-local-echo`; user approved the preview layout on 2026-09-15. |
| 2 | Relative mouse/trackpad | Document the proposal only; implementation and host validation are deferred. |

### 1. Passive Local Echo

The local text window is intentionally passive, not compose-and-send. Every key
continues through the existing complete-state protocol immediately. There is no
editable draft, Send button, paste-to-HID path, or replay of the displayed text.
The browser alone holds the echo; the firmware still receives key reports, never
text strings. USB descriptors, authorization, queues, deadlines, and host repeat
remain unchanged.

The window shows the browser's US-ANSI interpretation of outgoing key presses,
not the remote document. Host layout, IME, autocorrection, focus, cursor movement,
other input devices, and repeat settings are invisible. `queued` confirms only
acceptance into the board's queue, not USB completion or application rendering.
Unknown Caps Lock follows the current keycap estimate while the existing Caps
indicator stays unknown. Globe never implies knowledge of the active language.

| Action | Local echo behavior |
| --- | --- |
| New printable key-down | Append once after its ordered `queued` reply, using the report's effective Shift and the Caps snapshot at send time. |
| Release, duplicate state, second source holding the same key, or physical repeat | Add nothing. Do not simulate the host's auto-repeat. |
| Space | Append a space. |
| Backspace | Remove the last local character, if any; no attempt to inspect the remote caret or deletion result. |
| Return | A newly pressed Return clears the whole acknowledged report, even with simultaneous Space or punctuation. Return is still sent immediately through the normal key path. |
| Shift/Caps, Globe, Cancel/Escape | Add no text; Globe's modifier+Space is not an echoed space. |
| Clear local echo | Erase the local buffer and all pending echo updates without sending any host key. |
| Off, disarm, connection failure, logout, settings navigation, blur, or page hiding | Erase visible text and pending echo updates. A later reply or reconnection cannot restore them. |
| Keyboard page change or rotation | Preserve the echo, while keeping the existing release of held keys and one-shot modifiers. |

Keep only the latest 256 printable ASCII characters, in memory. Simultaneous new
usages have the deterministic order of the report; this is not a guarantee about
host chord interpretation. Backspace at the local boundary does nothing locally,
even if the host could delete earlier text. No input history, telemetry, console
logging, browser storage, or firmware storage is added for text.

The on/off setting is opt-in and defaults to off because the browser cannot know
when a remote password field is focused. An eye switch beside the host controls
enables it; turning it off also discards pending text rather than merely masking
the display. Only the boolean preference is saved in browser local storage under
`keyboard.local-echo.v1`. Invalid/unavailable stored values default to off; a
storage write failure leaves the current-session switch usable. Enable only for
non-sensitive text, especially in the existing HTTP/WS development profile.

Layout approved in the local preview on 2026-09-15:

- A read-only strip immediately above the keys, with two fixed-height lines in
  portrait and ordinary desktop layouts. It follows the latest text and wraps
  long words without expanding the keyboard or changing key sizes.
- A 44-by-44 eye switch with an accessible `Local echo` label and Show/Hide
  tooltip. A separate 44-by-44 clear icon acts only on this strip.
- Short landscape viewports use a single-line, horizontally scrolling strip
  alongside the compact host/key-map/Caps metadata. The keyboard remains below,
  including the existing inline Globe and Cancel controls.
- No editable textarea, native mobile keyboard, automatic text announcement, or
  caret suggesting a compose field. The readout is tabbable with a visible focus
  outline; its keyboard navigation and typing stay local and do not send host
  keys. Scrolling the readout does not disarm input; pointer cancellation for
  captured keyboard holds still releases normally.
- With echo off, remove the strip and retain the switch. Account and network
  forms remain isolated from remote keyboard capture.

Software gates: focused model tests; real Chromium/WebKit input and settings
checks; delayed/dropped acknowledgements, clearing and lifecycle tests; all three
keyboard pages with echo both on and off at the existing viewport/safe-area
matrix; inspected screenshots; and an ESP-IDF build recording image headroom.
No hardware flashing or partition/flash/PSRAM change is authorized by this work.

Initial software validation recorded 2026-09-15 (pre-review commit `d8ccd8f`):

- All 18 keyboard-model tests and ten ASan/UBSan native suites pass. The model
  covers every printable US-ANSI character, Shift/Caps, deduplicated holds,
  command isolation, Backspace, Return, and the 256-character limit.
- All 38 browser/API/provisioning tests pass. Echo tests cover preference-only
  persistence, invalid or unavailable storage, delayed acknowledgements,
  clearing pending edits, exact input semantics, transport failures, and
  lifecycle erasure in Chromium and WebKit. After the final readout-scroll
  guard, both engines' echo lifecycle tests and the existing mixed-input
  cancellation test were rerun and pass.
- Chromium checks all three keyboard pages with echo on and off across the
  existing ten-viewport matrix and portrait/landscape safe areas. Screenshots
  were inspected at phone portrait, short landscape, and desktop sizes. Long
  unbroken text stays bounded; controls do not overlap and keys retain their
  minimum sizes. WebKit also exercises echo-preserving rotation and touch.
- Fresh size-optimized ESP-IDF v6.1 builds pass from committed defaults:
  generic image `0xe2fb0` (929,712 bytes), free `0x1d050` (118,864 bytes);
  XinluCity image `0xe4480` (935,040 bytes), free `0x1bb80` (113,536 bytes).
  Both retain the existing 1 MiB app partition, about 11% free. This is below
  the broader 20% headroom target, not an operational-release signoff.
- Editor diagnostics and whitespace checks pass. No hardware was accessed;
  real controller/USB-host acceptance remains pending. The approved mock layout
  and software checks cannot establish the remote text's contents.

PR #12 Copilot review follow-up, 2026-09-16:

- Added an explicit non-editable focus target and local-only key handling for
  the readout. Chromium and WebKit tests verify Tab order, visible focus,
  horizontal arrow-key scrolling, no remote reports from readout key presses,
  keyboard activation of Clear, and normal typing afterward.
- Made a newly pressed Return terminal for the entire echo report. Model
  regressions cover simultaneous Space/punctuation/Backspace, Shift, and a
  previously held Return that must not clear later typing again.
- All ten native sanitizer suites, 19 model tests, and 40 browser/API tests
  pass locally. Both browser focus screenshots were inspected and editor
  diagnostics are clean. The initial image sizes above predate these fixes;
  the required PR checks validate both firmware profiles again before merge.

### 2. Relative Mouse/Trackpad Proposal

Mouse emulation is a later firmware/protocol increment, not a visual cursor added
to this page. Prefer a Keyboard/Pointer mode switch so a usable trackpad does not
permanently displace typing keys on short phone screens. Retain the local echo
above the active mode when space permits. No mouse UI, messages, or descriptors
are implemented in the local-echo branch.

The proposed first pointer surface provides relative movement, explicit left and
right buttons, hold-left-and-move dragging, and vertical scrolling. Defer
tap-to-click until accidental-click behavior has been tested. Do not require
Pointer Lock, predict remote cursor coordinates, or claim click success. The
remote screen is still needed to aim and observe results.

Keep the existing report-ID-free boot keyboard as HID interface 0 and add a
separate mouse interface through the pinned TinyUSB stack's multi-instance APIs.
The configuration would require two HID instances, descriptor/callback routing,
and verified boot/report-mode handling. Installing that firmware requires USB
re-enumeration and named Windows/macOS/iPadOS/iOS host tests; support or accessory
settings on one host must not be inferred from another.

Proposed pointer messages carry bounded relative deltas and complete button
state under the existing authenticated controller lease. Coalesce movement only
within an unchanged button state; preserve every button transition and its order
relative to typing. Bound accumulated movement and queue age, and respect the
selected HID report's numeric range. Never replay motion after reconnect or let
high-rate movement starve typing, heartbeats, or priority release. Stop, timeout,
cancel, blur, USB loss, and lease loss must release both keyboard keys and mouse
buttons and invalidate pending work. Button-hold ceilings and mixed-input safety
tests must be defined and implemented, not assumed from the current keyboard.

A future mouse click may move focus or the remote caret. Clearing the local echo
on a click is the proposed default for that increment, not a claim to detect the
remote change. Pointer-only movement would leave it intact. Final gestures,
cross-input ordering, resource budgets, and real-host acceptance remain deferred
decisions before mouse implementation.

## Reproducing Validation

Build with the configured ESP-IDF v6.1 environment first so the locked managed
components are available. Then, from the repository root:

```bash
bash tools/test-host.sh
npm ci --prefix tools --ignore-scripts
npm exec --prefix tools -- playwright install chromium --only-shell
npm exec --prefix tools -- playwright install webkit
npm --prefix tools test
```

Install the browsers' Linux dependencies through your approved setup process.
This WSL session instead unpacked the required Ubuntu libraries into the ignored
`.cache/browser-libs` directory, without changing the system installation. For
that existing cache and the pinned WebKit build, the tested environment is:

```bash
export WEBKIT_BUNDLE="$HOME/.cache/ms-playwright/webkit-2359/minibrowser-wpe"
export WEBKIT_EXECUTABLE_PATH="$WEBKIT_BUNDLE/bin/MiniBrowser"
export WEBKIT_EXEC_PATH="$WEBKIT_BUNDLE/bin"
export WEBKIT_INJECTED_BUNDLE_PATH="$WEBKIT_BUNDLE/lib"
export WEBKIT_INSPECTOR_RESOURCES_PATH="$WEBKIT_BUNDLE/share"
export LD_LIBRARY_PATH="$WEBKIT_BUNDLE/lib:$WEBKIT_BUNDLE/sys/lib:$PWD/.cache/browser-libs/usr/lib/x86_64-linux-gnu"
npm --prefix tools test
```

The executable override is only for this user-owned Linux runtime cache:
WebKit's bundled wrapper replaces `LD_LIBRARY_PATH`, hiding those libraries.
Ordinary installations with system dependencies do not need these overrides.
Browser tests start isolated mock servers and shut them down after testing.
Screenshots are generated under `.cache/tests`. Run `node tools/build-icons.mjs`
only when regenerating the checked-in icons from the pinned Lucide package;
the firmware build itself does not need npm.

## Preview Diagnostics

Run `npm --prefix tools run preview` and open `http://127.0.0.1:8080/`.
`PORT` selects another port; `PREVIEW_USB_READY=0` simulates unavailable USB.
`PREVIEW_CAPS_LOCK=1` starts the mock with Caps on, and `unknown` simulates
missing LED feedback. The mock does not type into any application or USB host.

`GET /__test__/input` returns aggregate key-down/key-up/stop/queued counts,
connection state, the current report, and mock Caps state. Counts are usage
transitions: adding a second source for the same key does not count as another
press. A plain tap adds one down, one up, and two queued reports; Shift/Caps can
add modifier-only or lock-key reports. The endpoint exists only in the loopback
preview, not in firmware. It keeps no report history. Ctrl+C prints a receipt
summary, and counters reset when the preview process restarts.

## Completion Record

All four automated phase gates passed in order. The agreed iPhone-style typing
scope is implemented; no computer-key panel or networking/security features were
added. After the automated work, on 2026-09-14 the user confirmed successful
flashing and board operation with both the separate-image ZIP and merged BIN.
Both formats therefore have a user-reported real-board smoke-test pass; see the
[hardware test record](../hardware/README.md#hardware-test-status).

The report did not include a per-feature matrix, exact host/controller OS details,
USB captures, or measurements. Detailed typing/Shift/Caps and input-method tests,
focus/network-loss release timing, USB lifecycle behavior, endurance, power/suspend
compliance, recovery, and PC/Mac/iPhone/iPad compatibility remain separate
acceptance checks. Playwright WebKit is engine-level evidence, not an actual
iPhone Safari test. No flash or memory configuration changes follow from this
status update.