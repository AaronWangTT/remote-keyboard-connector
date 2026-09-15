# Remote Keyboard Connector

ESP32-S3 Wi-Fi USB keyboard prototype using ESP-IDF v6.1. The firmware provides
standalone AP and saved Wi-Fi station modes, temporary AP+STA setup/recovery,
and the preferred name `kb.local`. Sender-provisioned private AP credentials,
one-time owner claim, browser login, and explicit keyboard control are included.
The iPhone-first US-ANSI keyboard provides letters, numbers, symbols,
Shift/Caps Lock, Backspace, Space, Return, host input-source switching, and
Cancel/Escape with bounded six-key USB reports.

The Wi-Fi enhancement passes automated native/browser checks and an ESP32-S3
build. It has not been provisioned or tested on the physical board. The earlier
[hardware smoke-test record](hardware/README.md#hardware-test-status) applies to
the previous keyboard-only firmware, not to these networking/authentication changes.

This is an authenticated HTTP/WS development prototype for protected, trusted
personal test networks and authorized, non-sensitive USB hosts. HTTP does not
protect passwords, sessions, or input from network interception. HTTPS/WSS and
encrypted credential storage remain lower-priority follow-up work.

## Documentation

- [CI workflow setup proposal](docs/ci-workflow-proposal.md)
- [Board status LED design, software validation, and remaining hardware gates](docs/board-status-led-proposal.md)
- [Sender installation and firmware artifact guide](docs/sender-installation.md)
- [Wi-Fi enhancement plan, implementation record, and remaining gates](docs/wifi-enhancement-plan.md)
- [Keyboard enhancement plan and validation results](docs/keyboard-enhancement-plan.md)
- [Minimal implementation plan and validation results](docs/minimal-implementation-plan.md)
- [Wi-Fi USB remote keyboard design specification](docs/remote-keyboard-design.md)
- [Development setup and proposed project structure](docs/development-setup.md)
- [Hardware details to confirm](hardware/README.md)

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

The target defaults to `esp32s3`. A successful build produces
`build/esp32s3_starter.bin`. Microsoft C/C++ IntelliSense is configured locally
to use the generated compilation database; the setup guide explains how to
apply that setting after a fresh clone.

### Optional Board Status LED

Generic builds leave GPIO48 untouched. The opt-in XinluCity ESP32S3 NANO /
ESP32-S3-N16R8 profile uses the schematic's active-low, single-color G48:
one short pulse every two seconds for ready/idle, steady ON for a valid live
controller, and two short pulses for not ready. PWR remains independent.
No brightness setting or web UI change is included.

See the [profile build commands and validation record](docs/board-status-led-proposal.md#software-implementation-record).
Software tests pass, but physical polarity, visible timing, and USB/load
acceptance remain pending; this is not approval to flash a board.

## Sender Provisioning

The sender prepares each board before shipping; recipients do not need ESP-IDF,
Python, a serial driver, or a flashing utility. From an ESP-IDF v6.1 terminal,
install the Node.js tools dependencies and validate the firmware offline:

```bash
npm ci --prefix tools --ignore-scripts
node tools/install-device.mjs --firmware build
```

Without `--execute`, the installer checks the three separate firmware images,
their digests, the partition table, and the build's security configuration.
It does not generate credentials or open a serial port. For downloaded CI
artifacts, extract the complete artifact (including its build manifest) and
pass its `build` directory to `--firmware`.

After verifying the board's factory base MAC, flash settings, power, and ROM
recovery procedure, one explicit command performs initial installation:

```text
node tools/install-device.mjs --firmware build --device-id <12-hex-digit-base-MAC> --output <new-private-directory-outside-repo> --port <COMx> --execute
```

The command creates a private firmware snapshot, per-device AP/setup credentials,
NVS image, Wi-Fi QR, and setup card. It checks the connected chip, expected MAC,
security state, and flash capacity; saves and verifies a full-flash backup;
then writes bootloader, partition table, application, and NVS in one sparse
esptool operation. All four images are verified before resetting the board.

**Existing partition tables must match, and non-empty NVS is refused by default.**
Only add `--replace-nvs` when deliberately discarding all existing NVS settings
and ownership after backup. It replaces the shared partition, not just the
`kb_identity` namespace. There is no automatic partition migration, whole-chip
erase, or eFuse change. Normal firmware updates must preserve NVS instead of
running this initial-install command again.

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
landscape. Globe sends Control+Space for the default iOS host profile or
Windows+Space for the Windows profile. The browser remembers an explicitly
selected valid profile, but does not detect the USB host, active language, or
whether the shortcut succeeded; the visible key map remains US ANSI. Cancel
sends one unmodified Escape tap. Escape may dismiss a pending host suggestion,
but it is not a guaranteed autocorrection undo and the page does not claim one.
Both controls clear held input and one-shot Shift before their host action.

Tap Shift for the next chord, hold for simultaneous typing, or double-tap for
Caps Lock. Caps state comes from USB host LED feedback, not a local guess. The
release button, focus loss, cancellation, disconnect, and safety deadlines clear
input. Reconnection never replays a hold, and page changes release hidden keys.
Host layout, Caps Lock, and auto-repeat determine the actual text produced.

Only typing keys and Shift are forwarded from the controller's physical
keyboard. Ctrl/Alt/Command shortcuts and input in other form fields stay local;
Left Control and Left GUI are generated only by the configured Globe action.
No function/navigation panel, emoji, dictation, autocorrect engine, swipe
typing, accented-key menus, or Unicode injection is included.

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
15 keyboard-model tests, and 34 API/Chromium/WebKit tests. Its ESP-IDF v6.1
build is `0xF6390` bytes, leaving `0x9C70` bytes (about 4%) in the unchanged
1 MiB application partition. Real iPhone/iPad input-source switching and
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
|   |-- board/             Opt-in G48 driver, status patterns, and native tests
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

The current default image is `0xf4ba0` bytes (1,002,400 bytes), leaving
`0xb460` bytes (46,176 bytes) in the existing 1 MiB application partition. The
opt-in status-LED image leaves `0x9c00` bytes (39,936 bytes); both have about 4%
headroom. See the LED implementation record for the checked configurations.
Flash layout and PSRAM settings are unchanged. This is below the broader 20%
headroom goal; physical flash capacity and runtime heap/stack/power behavior
remain unverified.

Do not commit credentials or machine-specific SDK paths. Generated build
outputs and local configuration are excluded by the Git ignore rules. Project
license selection is still pending.