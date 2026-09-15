# Remote Keyboard Connector

ESP32-S3 Wi-Fi USB keyboard prototype using ESP-IDF v6.1. The firmware provides
standalone AP and saved Wi-Fi station modes, temporary AP+STA setup/recovery,
and the preferred name `kb.local`. Sender-provisioned private AP credentials,
one-time owner claim, browser login, and explicit keyboard control are included.
The iPhone-first English (US) keyboard retains letters, numbers, symbols,
Shift/Caps Lock, Backspace, Space, and Return with bounded six-key USB reports.

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

## Sender Provisioning

The sender prepares each board before shipping; recipients do not need ESP-IDF,
Python, a serial driver, or a flashing utility. Install the tools dependencies,
then prepare private setup files using the verified factory base MAC:

```text
node tools/provision-device.mjs --device-id <12-hex-digit-base-MAC> --output <new-private-directory-outside-repo>
```

The utility generates a persistent unique AP password, a separate one-time owner
setup code, an NVS CSV, a PNG Wi-Fi QR code, and a printable setup card. The output
directory must be new and outside this repository. Windows ACLs or POSIX private
permissions restrict access. It does not print secrets, create a firmware package,
open a serial port, generate/write an NVS image, or erase a device.

**Do not flash this firmware onto the existing board until its identity and NVS
provisioning layout have been verified.** A complete sender workflow must use
Espressif's NVS tooling to install the private record explicitly; an NVS image
replaces a partition rather than merging settings. That device-writing step is
not automated here. Missing or inconsistent provisioning leaves Wi-Fi/control
disabled, without erasing NVS or falling back to the old public password.

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

Tap Shift for the next chord, hold for simultaneous typing, or double-tap for
Caps Lock. Caps state comes from USB host LED feedback, not a local guess. The
release button, focus loss, cancellation, disconnect, and safety deadlines clear
input. Reconnection never replays a hold, and page changes release hidden keys.
Host layout, Caps Lock, and auto-repeat determine the actual text produced.

Only typing keys and Shift are forwarded. Ctrl/Alt/Command shortcuts and input
in other form fields stay local. No function/navigation panel, emoji, dictation,
autocorrect, swipe typing, accented-key menus, or Unicode injection is included.

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

Five native suites (including owner-record persistence and eight USB-state cases), twelve keyboard-model
tests, and 24 provisioning/API/Chromium/WebKit tests pass in the Linux review
validation. Native Windows tests ran without sanitizers; the Linux runner
enables ASan/UBSan.
Browser tests verify receipt at a mock backend, not real USB delivery, mDNS,
radio behavior, or actual iPhone/iPad Safari. See the
[implementation record](docs/wifi-enhancement-plan.md#implementation-record).
The firmware has no npm runtime dependencies; the Lucide icons are embedded.

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
state, without retaining report history. Ctrl+C prints a summary. `PORT` selects
another port; `PREVIEW_USB_READY=0` exercises the waiting state, and
`PREVIEW_CAPS_LOCK=1` or `unknown` exercises Caps feedback states.

The full-state JSON protocol replaces the earlier single-key text commands.
`queued` means accepted, not USB completion. See the
[protocol contract](docs/keyboard-enhancement-plan.md#full-state-protocol).

## Continuous Integration

The [CI workflow](.github/workflows/ci.yml) defines two parallel checks on PRs to
`main`, pushes to `main`, and manual runs: **Firmware and Native Tests** and
**Browser Integration**. It builds in a pinned ESP-IDF v6.1 image, runs the
existing native/model tests, and exercises Chromium/WebKit on Ubuntu 24.04.
Successful firmware jobs upload the application, bootloader, and partition-table
images with `flasher_args.json`, `flash_args`, and a build summary. Available
logs/screenshots are retained for diagnosis, including failures; artifact
retention is 14 days.

Historically, PR #1's [first hosted run](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34860547440)
passed Browser Integration but failed the firmware job's post-build Git check
because of container checkout ownership. After an exact-workspace trust fix,
the [rerun](https://github.com/AaronWangTT/remote-keyboard-connector/actions/runs/34861221888)
passed both jobs, including native tests, packaging, and artifact uploads.
Those packaging steps belonged to PR #1 and were subsequently removed; current
CI uploads only the separate images and metadata listed above.
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
|   |-- board/             Reserved until board pins are verified
|   |-- device_identity/   Private identity and one-time owner claim
|   |-- network/           AP/STA, NVS settings, mDNS, and recovery jobs
|   |-- usb_keyboard/      HID descriptors, ordered reports, safety tests
|   `-- web_server/        Owner sessions, Network view, and typing pages
|-- docs/                   Setup notes and design documentation
|-- hardware/               Board identification and wiring documentation
|-- main/                   USB, AP, and web-service startup
`-- tools/                  Host tests, private setup-card preparation, and preview
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

The Wi-Fi enhancement image is `0xf3ec0` bytes (999,104 bytes), leaving
`0xc140` bytes (49,472 bytes, about 5%) in the existing 1 MiB application partition.
Flash layout and PSRAM settings are unchanged. This is below the broader 20%
headroom goal; physical flash capacity and runtime heap/stack/power behavior
remain unverified.

Do not commit credentials or machine-specific SDK paths. Generated build
outputs and local configuration are excluded by the Git ignore rules. Project
license selection is still pending.