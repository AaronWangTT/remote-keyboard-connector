# Remote Keyboard Connector

ESP32-S3 Wi-Fi USB keyboard prototype using ESP-IDF v6.1. The firmware provides
standalone AP and saved Wi-Fi station modes, temporary AP+STA setup/recovery,
and the preferred name `kb.local` (`x.local` on the standard Seeed XIAO
ESP32S3 profile). Sender-provisioned private AP credentials,
one-time owner claim, browser login, and explicit keyboard control are included.
The iPhone-first US-ANSI keyboard provides QWERTY letters with a `1`-`0` row
above them, separate number/symbol pages, Shift/Caps Lock, Backspace, Space,
Return, host input-source switching, and Cancel/Escape with bounded six-key
USB reports.

The Wi-Fi enhancement passes automated native/browser checks and an ESP32-S3
build. A user-reported XIAO connection/typing smoke test passed, with immediate
page loading after its external antenna was attached; full acceptance remains
pending. The earlier
[hardware smoke-test record](hardware/README.md#hardware-test-status) applies to
the previous keyboard-only firmware, not to these networking/authentication changes.

This is an authenticated HTTP/WS development prototype for protected, trusted
personal test networks and authorized, non-sensitive USB hosts. HTTP does not
protect passwords, sessions, or input from network interception. HTTPS/WSS and
encrypted credential storage remain lower-priority follow-up work. The dedicated
`POST /wakeup` endpoint is intentionally unauthenticated and is instead restricted
to TCP source address `192.168.1.2`; do not expose it through port forwarding.

## Documentation

- [CI workflow setup proposal](docs/ci-workflow-proposal.md)
- [Board status LED design, software validation, and remaining hardware gates](docs/board-status-led-proposal.md)
- [Board power management design, implementation, and sleep/wake validation gates](docs/board-power-management-proposal.md)
- [Sender installation and firmware artifact guide](docs/sender-installation.md)
- [OTA design, implementation, and hardware acceptance gates](docs/ota-proposal.md)
- [Wi-Fi enhancement plan, implementation record, and remaining gates](docs/wifi-enhancement-plan.md)
- [Captive portal pass-through proposal and implementation gates](docs/captive-portal-proposal.md)
- [Keyboard enhancement plan and validation results](docs/keyboard-enhancement-plan.md)
- [Minimal implementation plan and validation results](docs/minimal-implementation-plan.md)
- [Wi-Fi USB remote keyboard design specification](docs/remote-keyboard-design.md)
- [Development setup and proposed project structure](docs/development-setup.md)
- [Hardware details to confirm](hardware/README.md)

## Environment Setup

On Ubuntu 24.04 x86_64 (including WSL), install the full development environment:

```bash
bash tools/setup-dev.sh --with-vscode
source .cache/development-env.sh
idf.py build
```

The installer reuses ESP-IDF v6.1, preferring an existing VS Code/EIM registration,
and installs pinned Linux Node.js plus native/browser-test dependencies. It may
request your sudo password for system libraries; run it as your normal user.
It does not edit shell startup files, remove SDKs, or flash hardware.

Use `--firmware-only` to omit host/browser tooling, `--check` to check without
installing, or `--verify` to build in a separate directory and run applicable
tests. See the [setup guide](docs/development-setup.md#repeatable-ubuntu-and-wsl-setup)
for reruns, SDK selection, and existing build-cache handling.

## Build

Open the `remote-keyboard-connector` folder itself as the VS Code workspace so
its ESP-IDF and C/C++ settings apply. This folder is the intended GitHub
repository root; its parent directory is only a local container.

Select v6.1 with `ESP-IDF: Select Current ESP-IDF Version` and select `esp32s3`
with `ESP-IDF: Set Espressif Device Target`, then run
`ESP-IDF: Open ESP-IDF Terminal`. From the repository root:

```bash
idf.py build
```

The target defaults to `esp32s3` with 16 MiB flash, two 6 MiB OTA app slots, and
64 KiB NVS. Every normal build produces `build/firmware-install.zip` for wired
replacement and `build/firmware-ota.bin` for browser updates, containing identical
RSA-signed application bytes. Default builds use a local ignored test key,
not a trusted release key. Microsoft C/C++ IntelliSense is configured locally
to use the generated compilation database; the setup guide explains how to
apply that setting after a fresh clone.

An older ignored `sdkconfig` keeps the old layout and unsigned settings. Use a
fresh build/configuration directory to adopt the new defaults without changing
the board or overwriting your local configuration:

```bash
idf.py -B .cache/ota-build -D SDKCONFIG=.cache/ota-build/sdkconfig build
```

The build generates a test-only RSA-3072 key at `.cache/ota-test-signing-key.pem`
if absent. Keep it across development updates and never publish it. Build and
packaging perform no erase, flash, or per-device provisioning operation.

Tracked defaults select compiler size optimization for deployable firmware.
An existing generated `sdkconfig` retains its previous optimization choice;
before evaluating capacity, verify that generated `build/config/sdkconfig.json`
reports `COMPILER_OPTIMIZATION_SIZE=true`. A deliberate debug build can select
the debug optimization profile through menuconfig, but its larger image may
have substantially less partition headroom.

### Seeed Studio XIAO ESP32S3 (8 MiB)

The standard XIAO ESP32S3 uses the same `esp32s3` target but requires its own
8 MiB flash layout. It is **not** the 16 MiB XIAO ESP32S3 Plus. Do not flash
the default 16 MiB firmware on the standard XIAO.

Build from a fresh configuration, keeping existing builds and local settings:

```bash
idf.py -B .cache/xiao-build \
  -D SDKCONFIG=.cache/xiao-build/sdkconfig \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.board-seeed-xiao-esp32s3' build
node tools/install-device.mjs --firmware .cache/xiao-build \
  --verification-key .cache/xiao-build/firmware-signing-public.pem
```

The second command is an offline development check using the locally generated
test key's public half. Installation still requires an independently trusted
public key outside the candidate firmware directory and explicit erase consent.
No command above connects to or flashes hardware.

The XIAO profile retains 64 KiB NVS and two 3.875 MiB OTA slots, with a
3,248,128-byte signed-image budget. Its compatibility identifiers are
`seeed-xiao-esp32s3-8m` and `kb8-ab3875-nvs64-v1`. Artifacts are produced in
`.cache/xiao-build`, including `firmware-install.zip` and `firmware-ota.bin`.
Packaging, runtime startup, and installation check the exact board/layout and
8 MiB capacity; cross-profile OTA updates are rejected.

Fresh devices advertise **`x.local`** and their setup cards use
`http://x.local/`. Saved owner-selected hostnames remain unchanged by OTA.
The existing rename and mDNS conflict-handling behavior still applies, and
`http://192.168.4.1/` remains the AP fallback. Generic and XinluCity profiles
continue to default to `kb.local`.

The XIAO profile controls its active-low GPIO21 user LED: one 100 ms pulse
every two seconds when ready/idle, steady ON during active keyboard control,
and OFF when not ready. The battery-charge LED remains independent.
`BOARD_POWER_MANAGEMENT` enables GPIO0 BOOT wake and the power-settings control,
but fresh XIAO settings default to **Never**. Owners can save **30 minutes**,
**60 minutes**, or **Never**. Saved timeouts take precedence over the default.
GPIO48 is untouched. PSRAM remains disabled because the application does not
require it. Native USB HID uses the existing ESP32-S3 TinyUSB driver.

Use a fresh build/configuration directory to enable the new board controls;
an older generated configuration may retain `BOARD_POWER_MANAGEMENT=false`:

```bash
idf.py -B .cache/xiao-led-sleep \
  -D SDKCONFIG=.cache/xiao-led-sleep/sdkconfig \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.board-seeed-xiao-esp32s3' build
node tools/install-device.mjs --firmware .cache/xiao-led-sleep \
  --verification-key .cache/xiao-led-sleep/firmware-signing-public.pem
```

The default firmware version is now `0.1.1`, allowing an OTA update from
`0.1.0` with the same signing key, board, and layout. Update through `/ota`
using `firmware-ota.bin` to retain ownership and network settings; do not use
the destructive first-install workflow for an ordinary update. These commands
build and validate offline only. A subsequent user report says the XIAO LED
works as expected, but its installed firmware identity was not recorded.
Revision-matched LED acceptance, instrumented polarity/timing, sleep darkness,
BOOT wake, and USB reconnection remain pending; the assistant has not flashed
or reset the board.

Connect the supplied external antenna for reliable Wi-Fi. The user reported
slow page loading without it and immediate page loading after attaching it.

For a local UI preview without hardware, run
`PREVIEW_BOARD_PROFILE=seeed-xiao-esp32s3-8m npm --prefix tools run preview`.
The preview advertises the XIAO's hostname/layout/image budget and defaults its
power control to Never; it does not validate physical mDNS, GPIO, or USB behavior.

### Optional Board Status LED

Generic builds leave GPIO21 and GPIO48 untouched. On a fresh configuration, plain
`idf.py build` selects `BOARD_STATUS_LED_DISABLED`; an existing generated
`sdkconfig` retains whichever profile was selected previously.

For an interactive local build, run **ESP-IDF: SDK Configuration Editor
(menuconfig)**, then select **Board controls > Board profile > XinluCity
ESP32S3 NANO / ESP32-S3-N16R8 (G48 active-low)** and rebuild. This updates the
ignored local `sdkconfig`; do not commit that generated file.

For a reproducible profile build, use the tracked overlay with a fresh build
and configuration directory because `SDKCONFIG_DEFAULTS` does not override an
existing generated configuration:

```bash
idf.py -B .cache/board-led-enabled -D SDKCONFIG=.cache/board-led-enabled/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.board-xinlucity" build
```

Before flashing, verify the generated configuration reports
`BOARD_XINLUCITY_ESP32S3_NANO=true` and `BOARD_STATUS_LED_DISABLED=false`.
The profile uses the schematic's active-low, single-color G48: one short pulse
every two seconds for ready/idle, steady ON for a valid live controller, and
OFF for not ready. PWR remains independent. No brightness setting
is included. The selected board also exposes the automatic sleep feature below,
with Never selected until the owner opts in.

See the [profile build commands and validation record](docs/board-status-led-proposal.md#software-implementation-record).
Focused software checks and a 2026-09-15 physical check of the previously
flashed debug-optimized LED image passed for visible G48 ready/idle, active
control, and release back to idle. The optimized image described below was not
flashed. Startup/not-ready timing, suspend, failure handling, USB/load effects,
and endurance remain pending.

### Automatic Sleep

On the explicit XinluCity and XIAO profiles, `BOARD_POWER_MANAGEMENT` enables
the automatic deep-sleep feature. Both boards default to Never until the owner
opts into 30 or 60 minutes without meaningful activity. Existing saved timeout
choices remain unchanged by an update.
**Network settings >
Power > Auto sleep** offers **30 minutes**, **60 minutes**, and **Never**; Save
power setting persists the choice on the board. Generic and unsupported builds
do not claim the BOOT pin or expose the control.

Before sleeping, firmware revokes control, completes neutral USB input where
possible, stops Wi-Fi, detaches USB HID, and leaves the selected status LED off.
XinluCity releases and holds GPIO48's drivers/pulls; XIAO holds GPIO21 HIGH/off.
Press BOOT to wake
and restart services, then sign in and Take Control again. RST retains hardware
restart/recovery behavior. Saved owner and network settings survive; previous
sessions and queued keys do not. Background polls and heartbeats do not reset
the idle timer; valid held input and management/OTA work inhibit sleep.

XinluCity PWR and XIAO's charge indicator remain independent of firmware.
This is not a physical power switch. A host
that removes USB power after disconnect may require cable reconnection instead
of BOOT. Storage or sleep-preparation failures disable automatic sleep for the
current boot without changing the saved timeout. No new manual shutdown key is
included, and `Never` does not waive USB suspend-current requirements.

The [implementation record and acceptance gates](docs/board-power-management-proposal.md#implementation-record)
separate software checks from the still-pending physical power, wake, USB
reconnection, and host-suspend validation. No board was flashed for this feature.

## Sender Provisioning

The sender prepares each board before shipping; recipients do not need ESP-IDF,
Python, a serial driver, or a flashing utility. From an ESP-IDF v6.1 terminal,
install the Node.js tools dependencies and validate the firmware offline:

```bash
npm ci --prefix tools --ignore-scripts
node tools/install-device.mjs --firmware build --verification-key build/firmware-signing-public.pem
```

Without `--execute`, the installer checks the four public firmware images,
their signatures/digests, the partition table, and the build's security profile.
It does not generate credentials or open a serial port. For downloaded CI
artifacts, extract the complete artifact (including its build manifest) and
pass the extracted install directory to `--firmware`. The generated public key
above is for local test inspection; actual installation needs a trusted public
key obtained independently and stored outside the candidate directory.

After verifying the board's factory base MAC, flash settings, power, and ROM
recovery procedure, one explicit command performs initial installation:

```text
node tools/install-device.mjs --firmware build --verification-key <trusted-public-PEM-outside-bundle> --device-id <12-hex-digit-base-MAC> --output <new-private-directory-outside-repo> --port <COMx> --execute --reset-layout
```

The command creates a private firmware snapshot, per-device AP/setup credentials,
NVS image, Wi-Fi QR, and setup card. It checks the connected chip, expected MAC,
security state, and 16 MiB flash capacity; explicitly erases the old installation;
then writes bootloader, partition table, OTA metadata, application, and fresh NVS.
Every written range and the application signature are verified before reset.
An intentionally installed test-key build also requires `--allow-test-firmware`.

**Wired replacement assumes a fresh installation with full layout reset.**
Repeat ownership claim and Wi-Fi setup afterward. There is no dedicated migration
tool or old-NVS conversion, and no eFuse change. Optional old-flash backups are
private user precautions, not installation inputs.

For routine OTA, use either AP or station mode and open `http://kb.local/ota`
directly, or append `/ota` to the device's current hostname/IP address. This
is a separate page with no links or buttons connecting it to the keyboard or
network settings pages. Sign in with the owner password if needed; the existing
owner session is also accepted. Upload `firmware-ota.bin`, wait for verification,
then choose Install and restart. Sign in again on `/ota` and confirm the running
version. The inactive
slot is written, a failed trial boot rolls back, and credentials/settings are
preserved. Uploads require a higher `major.minor.patch` version, matching
board/layout, and the same signing key. USB host enumeration is not required.

The personal-use profile uses 10 PBKDF2-HMAC-SHA-256 iterations for responsive
login, deliberately sacrificing most offline password-guessing resistance.
Salted verifiers, owner authentication, CSRF checks, and rate limits remain;
this is not an Internet-exposed or hardened security profile.

See the [sender guide](docs/sender-installation.md) for prerequisites, private
artifacts, and failure handling. The original
[file-preparation utility](tools/provision-device.mjs) remains available for
CSV/QR/card generation only. Missing or inconsistent provisioning still leaves
Wi-Fi/control disabled. The combined installer has software-test coverage;
physical installation, owner claim, and recovery acceptance remain pending.

## Keyboard Operation

After sender provisioning and hardware validation, join
`WiFiKeyboard-<last-six-factory-MAC-hex-digits>` using the private Wi-Fi QR card.
Open `http://kb.local/`, or the default AP fallback `http://192.168.4.1/`. Claim
ownership once with the setup code and choose an owner password of 12-128 bytes.
The setup code is retired after a successful claim; the AP password remains
valid for standalone use and recovery. Later visits use the owner password.

Select **Take Control** before typing. Only one controller is allowed across AP
and STA together. Release, focus loss, disconnect, sign-out, and network changes
require fresh explicit acquisition; reconnecting never resumes held input.

Take Control reserves the controller for up to 10 seconds while the browser
establishes its WebSocket. The browser allows 8 seconds for connection setup,
including hostname resolution and TCP/HTTP Upgrade, before disconnecting.
Input remains disabled until a USB-ready status arrives. These setup windows
do not extend the active controller's 1-second lease/reply deadline or the
250 ms input acknowledgement deadline, and do not automatically retry or replay
keys. A cancelled attempt can retain its pending reservation until it expires
or an explicit Release clears it.
Failures show a specific connection status and an alert: control request
rejection/unreachability, HTTP connection capacity exhaustion, WebSocket setup timeout/failure, connection loss,
missing replies/input confirmations, invalid responses, input safety limits,
or USB becoming unavailable. `USB unknown` means no current USB status is
available, not a confirmed HID fault; a known USB-not-ready rejection shows
`USB waiting`. Failure status survives focus changes and session refresh while
signed in, until another Take Control, explicit Release or sign-out.
Normal Release clears the failure; foreground/background transitions do not
create new failure notifications.
Each page keeps Take Control disabled while an earlier Take, explicit Release,
or obsolete-success cleanup is still pending; **Finishing control request**
indicates that barrier. A response from an old attempt/session cannot invalidate
the current login. Obsolete-success cleanup is skipped after a session change.
This serializes operations within the page without changing the existing
explicit global priority-Stop behavior. Take replies include a positive
`control_id`; automatic obsolete-success cleanup sends it in `X-Control-Id`.
The server only stops matching pending/active control owned by that session;
a replaced/released ID returns 409 `control_request_stale`, treated as an
explicitly logged obsolete cleanup. A missing header retains manual global
Stop behavior; malformed scoped IDs return 400 `invalid_control_request`.
Refresh the page after updating firmware so the matching client code is loaded.
These notifications do not retry or replay input. Scoped automatic cleanup
cannot clear a newer acquisition; explicit Release retains priority Stop.
Before creating a reservation, Take Control checks the HTTP server client count,
including the current request. When all seven slots are occupied, it marks this
Take Control response `Connection: close` and queues closure of only that
request's HTTP connection after the synchronous response completes, allowing
the subsequent WebSocket to use the released slot. The owner session/cookie
and pending reservation survive this transport close. With spare capacity,
normal HTTP keep-alive is unchanged. Other connections are never selected
for closure, and Stop retains its existing behavior.
Failure to inspect capacity or set the close header returns
`connection_capacity_unavailable` and is logged. Failure to queue the close
returns HTTP 503 `connection_capacity_exhausted` and **Connections full**, without
creating a reservation. This is not an exclusive TCP-slot reservation: another
connection can consume the released slot and setup can still time out.
No general idle-connection reclamation, increased limits or automatic retry is
introduced.
The local preview can simulate a delayed Upgrade with
`PREVIEW_WEBSOCKET_DELAY_MS=5500`; it accepts 0-15000 ms and defaults to no
injected delay. This test setting is not part of the firmware.
`PREVIEW_HTTP_CAPACITY_FULL=1` simulates pressure and closes successful Take
Control responses; combine it with `PREVIEW_CONTROL_CLOSE_FAILED=1` to simulate
failed closure preparation and exercise the explicit full-capacity error.

The Network view offers Standalone AP or Join Wi-Fi, scan/manual SSID entry,
credential testing, saved-network reuse, hostname changes, and confirmed Forget
Network. This increment supports one 2.4 GHz WPA2-Personal profile and DHCP.
Successful association and DHCP save the profile; **Switch to Wi-Fi** confirms
handover before the temporary AP closes after a 15-second grace period. No
Internet connection is required. Failed tests preserve the last committed
profile and AP access. Router loss starts bounded retries and protected recovery.
Physical-button recovery is not implemented until board wiring is verified.

Typing keys are enabled only while USB is ready. Keep the page visible and the
keyboard surface focused for physical typing, or use mouse/touch. `123`, `#+=`,
and `ABC` select the familiar iPhone-style pages; this is a custom web keyboard,
not the native iOS keyboard. Phone letter keys use the approved narrower widths
to fit ten columns; key heights remain at least 44 CSS pixels.

Globe and Cancel sit below the keycap row in portrait and join the Space row in
landscape. The Host toggle offers iOS and Win. Globe sends Control+Space for
the default iOS host profile or Windows+Space for the Windows profile. The browser
remembers an explicitly selected valid profile, but does not detect the USB host,
active language, or
whether the shortcut succeeded; the visible key map remains US ANSI. Cancel
sends one unmodified Escape tap. Escape may dismiss a pending host suggestion,
but it is not a guaranteed autocorrection undo and the page does not claim one.
Both controls clear held input and one-shot Shift before their host action.

Tap Shift for the next chord, hold for simultaneous typing, or double-tap for
Caps Lock. With Host set to Win, short on-screen Shift taps do not send a
standalone Shift: the modifier is sent with typing keys, avoiding the Chinese
IME mode toggle caused by a bare Shift tap. To request an IME mode toggle,
hold Shift alone for at least one second and release it. This sends one Left
Shift tap and clears the one-shot latch. Other keyboard input during the hold,
including physical keys that are not forwarded, or cancellation suppresses
that gesture. The IME must have Shift mode switching
enabled; the page cannot observe its mode. iOS and physical Shift key mappings
are unchanged. Changing Host clears held input and one-shot Shift without
completing a pending IME gesture; it sends only a release if input was active.
An unsupported saved Host disables Globe and on-screen Shift until a valid
profile is selected; ordinary typing and physical Shift remain available.

Caps state comes from USB host LED feedback, not a local guess. The release
button, focus loss, cancellation, disconnect, and safety deadlines clear
input. Reconnection never replays a hold, and page changes release hidden keys.
Host layout, Caps Lock, and auto-repeat determine the actual text produced.

Only typing keys and Shift are forwarded from the controller's physical
keyboard. Ctrl/Alt/Command shortcuts and input in other form fields stay local;
Left Control and Left GUI are generated only by the configured Globe action.
No function/navigation panel, emoji, dictation, autocorrect engine, swipe
typing, accented-key menus, or Unicode injection is included.

### Windows Wake API

An iStoreOS service running at `192.168.1.2` can request a Windows host wake:

```bash
curl --fail-with-body -X POST http://kb.local/wakeup
```

When iStoreOS reaches the keyboard through a router port-forward, destination
NAT does not normally rewrite the HTTP `Host` header. Set it explicitly to the
keyboard's hostname (or its actual LAN IP):

```bash
curl --fail-with-body -X POST http://ROUTER_ADDRESS:FORWARDED_PORT/wakeup \
  -H "Host: kb.local"
```

Ordinary destination NAT normally preserves the iStoreOS source address. If the
router also applies source NAT, the keyboard will see the router's LAN address
instead of `192.168.1.2`; either disable that source NAT for this rule or update
the firmware allowlist after verifying the observed address. The forwarding
rule should itself accept traffic only from the iStoreOS source.

The request body must be empty. This route deliberately skips owner-session and
CSRF checks. It accepts only a real TCP peer address of `192.168.1.2`, while the
`Host` header must still identify this keyboard by its current hostname or IP.
`Origin` may be omitted for a server-side request; if supplied, it must be
`http://192.168.1.2` (optionally with explicit port `80`). Header values alone
are not treated as proof of the caller address.

The USB descriptor advertises Remote Wakeup. If USB is suspended and Windows
enabled that feature, firmware first requests USB remote wake. Once USB is
active, or immediately if it was already active, firmware sends one unmodified
F24 press followed by release. F24 is chosen because Windows has no default
system action for it, although installed software can register an F24 shortcut.

A `200` response is sent only after both HID reports complete:

```json
{"ok":true,"remote_wakeup_sent":true,"usb_active":true,"key":"F24","key_delivered":true}
```

`remote_wakeup_sent` is `false` when USB was already active. Completion proves
that the host resumed polling the HID endpoint and accepted the F24 tap. It does
not prove that the display is on, the session is unlocked, or user applications
are ready. A disabled Windows wake setting returns `409`; a report timeout,
disconnect, or transfer failure returns a non-2xx response.

Windows, the USB controller, firmware/BIOS, and the selected USB port must all
allow keyboard wake, and the port must remain powered during sleep. Use Device
Manager or `powercfg /devicequery wake_armed` to verify the wake-enabled device.
Hibernate and shutdown wake are not guaranteed. Configure this board's Auto
sleep setting to **Never** if `/wakeup` must remain reachable while the PC
sleeps. Physical Windows sleep/wake validation is still required for each host.

## Host Validation

After the firmware build has fetched its managed dependencies, run:

```bash
node tools/test-native.mjs
node --test components/web_server/test/browser_input_test.mjs
npm ci --prefix tools --ignore-scripts
npm exec --prefix tools -- playwright install chromium --only-shell
npm exec --prefix tools -- playwright install webkit
npm --prefix tools test
```

The native runner accepts `HOST_CC` pointing to GCC, Clang, or Zig; a Zig
executable is automatically invoked with its `cc` subcommand. On this Windows
workspace it uses the checksum-verified Zig 0.15.2 installation in the ignored
`.cache/toolchains` folder. Fresh machines must supply a host compiler; the
ESP cross-compiler cannot execute native unit tests. The Bash entry point
`tools/test-host.sh` uses the same suite list with a Linux compiler.
On Linux, the runner selects `/usr/bin/` binutils explicitly so an activated
ESP-IDF toolchain cannot substitute a cross-assembler or linker.

The Wi-Fi enhancement validation recorded five native suites (including owner-record
persistence and eight USB-state cases), twelve keyboard-model tests, and 25
provisioning/API/Chromium/WebKit tests passing in the Linux review. Native
Windows tests ran without sanitizers; the Linux runner enables ASan/UBSan.
Browser tests verify receipt at a mock backend, not real USB delivery, mDNS,
radio behavior, or actual iPhone/iPad Safari. See the
[implementation record](docs/wifi-enhancement-plan.md#implementation-record).
The [sender guide](docs/sender-installation.md#verification) lists the additional
installer checks, including SDK-backed fake-device tests that never use hardware.
The firmware has no npm runtime dependencies; the Lucide icons are embedded.

The Globe/Cancel software increment passes all ten sanitized native suites,
15 keyboard-model tests, and 34 API/Chromium/WebKit tests. After integrating
compiler size optimization, fresh ESP-IDF v6.1 builds measure:

| Profile | Application size | Free in the unchanged 1 MiB app partition |
| --- | --- | --- |
| Generic, LED disabled | `0xe19d0` (924,112 bytes) | `0x1e630` (124,464 bytes, about 12%) |
| XinluCity status LED | `0xe2ea0` (929,440 bytes) | `0x1d160` (119,136 bytes, about 11%) |

Both builds have `COMPILER_OPTIMIZATION_SIZE=true` and remain below the 20%
product headroom goal. The earlier `0xF63E0`/`0x9C20` measurement describes the
debug-optimized generic build before these defaults changed, not a fresh build.
Real iPhone/iPad input-source switching and
Escape behavior with pending, applied, and absent autocorrection suggestions
remain hardware acceptance checks, not conclusions from the browser mock.

For an interactive UI-only preview:

```bash
npm --prefix tools run preview
```

Open `http://127.0.0.1:8080/`. USB is mocked and no keystrokes leave the preview.
Sign in with the public mock-only password `preview-owner-password`, then take
control or open Network settings. Do not use real credentials in the preview.
`PREVIEW_CLAIMED=0` starts first-use setup with the public fixture code
`0123456789abcdef01234567`. These credentials exist only in the loopback mock,
not in the firmware. Mock router password `wrong-password` triggers failure;
`offline-network` and `no-dhcp-network` simulate network/DHCP failures, while
`overlap-network` exercises the confirmed AP-address transition. Mock handover
timing is accelerated and never switches the computer's Wi-Fi.
Check `http://127.0.0.1:8080/__test__/input` for receive counters; a tap adds one
`down`, one `up`, and two `queued` replies. Shift/Caps actions can add extra
modifier/lock reports. The endpoint also shows the current report and mock Caps
state, without retaining report history. Globe and Cancel each send a forced
neutral, one command report, and a final neutral, producing three `queued`
replies. Ctrl+C prints a summary. `PORT` selects another port;
`PREVIEW_USB_READY=0` exercises the waiting state, and
`PREVIEW_CAPS_LOCK=1` or `unknown` exercises Caps feedback states.

The full-state JSON protocol replaces the earlier single-key text commands.
`queued` means accepted, not USB completion. See the
[protocol contract](docs/keyboard-enhancement-plan.md#full-state-protocol).

## Continuous Integration

The [CI workflow](.github/workflows/ci.yml) defines two parallel checks on PRs to
`main`, pushes to `main`, and manual runs: **Firmware and Native Tests** and
**Browser Integration**. It builds in a pinned ESP-IDF v6.1 image, runs the
existing native/model tests, and exercises Chromium/WebKit on Ubuntu 24.04.
The firmware job also compiles the opt-in status-LED profile, asserts that the
generic build stays LED-disabled, and runs installer safety tests and offline
artifact validation. Uploaded firmware remains the generic LED-disabled build.
Successful jobs upload the separate application, bootloader, partition table,
generated flash metadata, a credential-free manifest with image hashes/security
settings, and a build summary. GitHub Actions provides the
download archive; there is no nested firmware ZIP, merged BIN, or per-device NVS
image in CI. Private identities and backups are generated only by explicit local
sender installation. Available logs/screenshots are retained for diagnosis,
including failures; artifact retention is 14 days.

Historically, PR #1's [first hosted run](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34860547440)
passed Browser Integration but failed the firmware job's post-build Git check
because of container checkout ownership. After an exact-workspace trust fix,
the [rerun](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34861221888)
passed both jobs, including native tests, the original ZIP/BIN packaging, and
artifact uploads. Those packaging steps belonged to PR #1 and were subsequently
removed; current CI uploads only the separate images and metadata listed above.
Those runs do not establish the combined installer's hardware acceptance.
Both checks are required by `main`'s ruleset. See the proposal for the validation
record and security boundaries.

## Current Layout

```text
remote-keyboard-connector/
|-- CMakeLists.txt          ESP-IDF project definition
|-- dependencies.lock      Pinned managed-component versions
|-- sdkconfig.defaults     Shared target defaults
|-- .github/workflows/       PR/main firmware and browser CI
|-- .vscode/                Portable extension recommendations
|-- components/
|   |-- board/             Board LED/sleep drivers, shared status patterns, and native tests
|   |-- device_identity/   Private identity and one-time owner claim
|   |-- network/           AP/STA, NVS settings, mDNS, and recovery jobs
|   |-- usb_keyboard/      HID descriptors, ordered reports, safety tests
|   `-- web_server/        Owner sessions, Network view, and typing pages
|-- docs/                   Setup notes and design documentation
|-- hardware/               Board identification and wiring documentation
|-- main/                   USB, AP, and web-service startup
`-- tools/                  Host tests, guarded sender installation, and preview
```

Reserved empty directories use `.gitkeep` placeholders so they can be tracked.
VS Code extension recommendations do not install extensions automatically.

## Next Steps

1. Identify the exact board, module variant, flash capacity, PSRAM, and USB
   connection using the hardware checklist.
2. Follow the [remote Dev Box USB guide](docs/development-setup.md#remote-dev-box-usb)
   before attempting USB forwarding from the local Windows PC into remote WSL.
3. Confirm a ROM recovery procedure and a logging path that does not depend on
   native USB Serial/JTAG remaining available while HID is running.
4. Validate USB enumeration, AP access, typing/Shift/Caps reports, and releases
   on a consenting desktop host and real iPhone/iPad controller before broader
   compatibility claims. Record actual report timing and host LED feedback.

Before the Globe/Cancel increment, compiler size optimization with the XinluCity
status-LED profile produced an image of `0xe17c0` bytes (923,584 bytes), leaving
`0x1e840` bytes (124,992 bytes, about 12%) in the existing 1 MiB application
partition. That build removed ESP-IDF's nearly-full warning and saved 86,368
bytes compared with the later `0xf6920`-byte (1,009,952-byte) debug-optimized LED image that was
physically flashed during hardware validation. The earlier isolated profile
build recorded `0xf6400`; it was not the comparison baseline. Flash layout,
NVS offsets, and PSRAM settings are unchanged. The result remains below the
broader 20% product headroom goal. Enlarging or replacing the live partition
table is a separate migration, not a routine firmware update; runtime
heap/stack/power behavior also remains to be fully characterized.

Do not commit credentials or machine-specific SDK paths. Generated build
outputs and local configuration are excluded by the Git ignore rules. Project
license selection is still pending.
