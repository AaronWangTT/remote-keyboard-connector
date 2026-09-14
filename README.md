# Remote Keyboard Connector

ESP32-S3 Wi-Fi USB keyboard prototype using ESP-IDF v6.1. The firmware provides
a default access point and an iPhone-first English (US) typing keyboard with
letters, numbers, symbols, Shift/Caps Lock, Backspace, Space, and Return.
Physical keyboard, mouse, and touch input share a bounded six-key USB report
path. The page also fits tablet and desktop sizes. Automated host/browser tests
and firmware builds pass. On 2026-09-14 the user confirmed successful flashing
and operation on their board using both the separate-image ZIP and merged BIN.
This is a user-reported hardware smoke-test pass; detailed safety, power, and
host/controller compatibility results remain pending. See the
[hardware test record](hardware/README.md#hardware-test-status).

This is an unauthenticated HTTP/WS development prototype. Use only with an
authorized, non-sensitive test host on an isolated network. The AP password is
a public development default, not owner authentication.

## Documentation

- [CI workflow setup proposal](docs/ci-workflow-proposal.md)
- [Keyboard enhancement plan and validation results](docs/keyboard-enhancement-plan.md)
- [Minimal implementation plan and validation results](docs/minimal-implementation-plan.md)
- [Wi-Fi USB remote keyboard design specification](docs/remote-keyboard-design.md)
- [Development setup and proposed project structure](docs/development-setup.md)
- [Hardware details to confirm](hardware/README.md)

## Build

Open the `remote-keyboard-connector` folder itself as the VS Code workspace so
its ESP-IDF and C/C++ settings apply. This folder is the intended GitHub
repository root; its parent directory is only a local container.

Select v6.1 with `ESP-IDF: Select Current ESP-IDF Version`, then run
`ESP-IDF: Open ESP-IDF Terminal`. From the repository root:

```bash
idf.py build
```

The target defaults to `esp32s3`. A successful build produces
`build/esp32s3_starter.bin`. Microsoft C/C++ IntelliSense is configured locally
to use the generated compilation database; the setup guide explains how to
apply that setting after a fresh clone.

## Local Flash Package

To package the latest build for flashing on a separate Windows machine:

```bash
idf.py build
node tools/package-firmware.mjs
```

This creates `build/firmware-package.zip` and its `.sha256` sidecar. The ZIP
contains the three images, generated offsets/settings, manifest/checksums,
dependency lock, and Windows instructions. The packager uses Node.js and the
build environment's Python standard-library ZIP command; it does not flash or
erase a device. See the [local flashing guide](docs/flashing-local.md), especially
the unverified flash settings and native USB recovery requirements.

## Keyboard Operation

After hardware validation and flashing, the board is configured to start
`WiFiKeyboard-<last-six-MAC-hex-digits>` with password `a-key-test-only`. Join that
AP and open `http://192.168.4.1/`. No station credentials or Wi-Fi setup page are
required. Only one associated controller and one input WebSocket are supported.

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
bash tools/test-host.sh
npm ci --prefix tools --ignore-scripts
npm exec --prefix tools -- playwright install chromium --only-shell
npm exec --prefix tools -- playwright install webkit
npm --prefix tools test
```

See the [test prerequisites and WSL runtime-library setup](docs/keyboard-enhancement-plan.md#reproducing-validation).
Eight native USB tests, JSON parser checks, twelve model/layout tests, and ten
Chromium/WebKit integration tests pass. They verify actual WebSocket receipt at
a mock backend, not USB delivery or real iPhone/iPad Safari compatibility. The
firmware has no npm runtime dependencies; the small Lucide icon set is embedded.

For an interactive UI-only preview:

```bash
npm --prefix tools run preview
```

Open `http://127.0.0.1:8080/`. USB is mocked and no keystrokes leave the preview.
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
Successful firmware jobs upload the separate-image ZIP and merged BIN with
checksums and a build summary. Available logs/screenshots are retained for
diagnosis, including failures; artifact retention is 14 days.

The workflow is locally validated but still needs its first hosted PR run.
Required CI checks have not yet been added to `main`'s ruleset. After both jobs
pass on GitHub, require those check names while retaining the existing PR policy
with zero reviewer approvals. See the proposal for the rollout, security
boundaries, exact pins, and what remains unverified.

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
|   |-- network/           Default development AP
|   |-- usb_keyboard/      HID descriptors, ordered reports, safety tests
|   `-- web_server/        HTTP/WS handlers and iPhone-style typing pages
|-- docs/                   Setup notes and design documentation
|-- hardware/               Board identification and wiring documentation
|-- main/                   USB, AP, and web-service startup
`-- tools/                  Host tests and loopback-only browser preview
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

The enhanced image is `0xd7ff0` bytes, leaving 16% in the existing application
partition. Actual flash capacity, power/suspend behavior, and the broader
product's 20% partition-headroom goal are not yet verified.

Do not commit credentials or machine-specific SDK paths. Generated build
outputs and local configuration are excluded by the Git ignore rules. Project
license selection is still pending.