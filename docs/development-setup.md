# ESP32-S3 Development Setup and Project Structure

Current firmware uses authenticated AP/STA networking and owner setup; see the
[Wi-Fi implementation record](wifi-enhancement-plan.md) and the
[current sender-provisioning instructions](../README.md#sender-provisioning).
This page retains earlier environment and keyboard-only setup notes. References
below to unauthenticated AP access, ZIP/merged-BIN packages, or their flashing
workflow are historical, not the current provisioning or CI artifact contract.

On 2026-09-14 the user reported successful board operation with the earlier
keyboard-only ZIP and merged BIN; see the
[hardware test record](../hardware/README.md#hardware-test-status). That smoke
test does not validate the authenticated Wi-Fi firmware. Current device safety,
power, provisioning, and host/controller compatibility gates remain open.

In the verified WSL EIM installation, the working activation command is:

```bash
source "$HOME/.espressif/tools/activate_idf_v6.1.sh"
```

The SDK's generic export script assumed a different legacy tools layout. The
VS Code build command also failed on a literal `${workspaceFolder}` path;
EIM-activated `idf.py build` was used successfully without changing editor settings.

Planning baseline: 2026-09-14. This is a setup proposal, not a record of a
completed installation. Board-specific choices remain open until the exact
board and module variant are identified.

## Recommended Stack

Use native ESP-IDF for the firmware project.

| Area | Recommendation |
| --- | --- |
| Framework | ESP-IDF with its included FreeRTOS support |
| SDK version | ESP-IDF v6.1, identified as stable in the official documentation when this proposal was prepared |
| Language | Start with C; introduce C++ selectively when useful |
| Build tools | ESP-IDF's CMake and Ninja workflow through `idf.py` |
| Editor | Windows VS Code connected to Ubuntu using the WSL extension |
| Installation | ESP-IDF Installation Manager (EIM), launched from the ESP-IDF extension inside WSL |
| Debugging | Serial logging first; built-in USB-JTAG with Espressif OpenOCD and GDB later |
| Dependencies | ESP-IDF Component Manager with tracked manifests and a generated dependency lock file |
| Source control | Git inside WSL, followed by GitHub and a build workflow using the same pinned ESP-IDF version |

ESP-IDF has a steeper initial learning curve than Arduino, but provides the
official APIs, FreeRTOS integration, configuration system, partition management,
and debugging support. It is the recommended foundation for learning the chip
and maintaining a growing project.

Arduino is a reasonable alternative for quick sketches or an Arduino-specific
library. It can also be used as an ESP-IDF component, subject to version
compatibility. PlatformIO is an alternative development toolchain, not another
required layer. Avoid having PlatformIO and the ESP-IDF extension both manage
this project.

Before installing the SDK, check whether the board vendor's board support
package (BSP) or required libraries support the proposed version. Display,
camera, and audio boards may require a different supported release. Pin the
chosen release for both local development and CI; do not follow the moving
`master` branch.

## Existing Environment

The read-only audit performed when this proposal was prepared found:

| Item | Status |
| --- | --- |
| Host development environment | WSL2, Ubuntu 24.04.4 LTS, x86_64 |
| Workspace at initial audit | `/home/yuwag/ESP32S3` |
| Git | 2.43.0 |
| Python | 3.12.3 |
| CMake | 3.28.3 |
| VS Code CLI | Available |
| Ninja | Not found on PATH |
| `idf.py` | Not found on PATH |
| EIM | Not found on PATH |
| `lsusb` | Not found on PATH |

The project has since moved to
`/home/yuwag/ESP32S3/remote-keyboard-connector`. Use this directory as the GitHub
repository root and VS Code workspace root. The original generated build was
preserved under `.cache/build-before-relocation`; the active `build/` directory
has been regenerated for the new location. Both directories are ignored by Git.

The audit did not verify Windows-side `usbipd-win` installation or board access.
The Linux `usbip` command was also absent, but it is not required for the modern
Windows-side `usbipd attach --wsl` workflow described below.

## Setup Sequence

### 1. Keep the Project in WSL

Keep the project and Linux SDK installation in the WSL filesystem. The current
workspace location is suitable. Avoid building under `/mnt/c/...` because
cross-filesystem access can slow builds and file watching.

Install VS Code on Windows and connect it to WSL; a separate Linux desktop
installation of VS Code is not necessary. Keep ESP-IDF and its toolchains outside
the project repository, in locations managed by EIM.

### 2. Prepare Windows

Run these commands in Windows PowerShell, allowing elevation when required:

```powershell
wsl --update
wsl -l -v
winget install --interactive --exact dorssel.usbipd-win
```

Confirm the Ubuntu distribution is using WSL version 2. The USB instructions
below assume `usbipd-win` 5.0 or newer. The interactive installation option lets
you handle any installer prompts, including a requested restart.

### 3. Install Linux Prerequisites

Run inside Ubuntu in WSL:

```bash
sudo apt update
sudo apt install git wget flex bison gperf python3-pip python3-venv \
  python3-setuptools cmake ninja-build ccache libffi-dev libssl-dev \
  dfu-util usbutils
```

Let EIM install the matching Espressif cross-compiler, debugger, OpenOCD, and
Python environment. Do not install a separate global collection of ESP-IDF
Python packages or an unrelated cross-compiler.

### 4. Configure VS Code and ESP-IDF

Install these extensions in the indicated location:

| Extension | Identifier | Location |
| --- | --- | --- |
| WSL | `ms-vscode-remote.remote-wsl` | Windows |
| ESP-IDF | `espressif.esp-idf-extension` | WSL window |
| C/C++ | `ms-vscode.cpptools` | WSL window |

Open the project from a WSL terminal:

```bash
cd /home/yuwag/ESP32S3/remote-keyboard-connector
code .
```

Open the project folder itself, not the parent `ESP32S3` folder, so workspace
settings and build commands resolve against the new root. Confirm the VS Code
window is connected to WSL. In the Command Palette:

1. Run `ESP-IDF: Open ESP-IDF Installation Manager`.
2. Use the WSL CLI wizard to install the selected ESP-IDF release and tools for
   the `esp32s3` target.
3. Run `ESP-IDF: Select Current ESP-IDF Version` and choose that installation.
4. Run `ESP-IDF: Doctor Command` to check the setup.

Run subsequent `idf.py` commands in an ESP-IDF terminal with that installation's
environment activated. Keep machine-specific SDK paths and serial-port settings
local rather than committing them to Git.

### 5. Connect the Board to WSL

These commands run on the Windows computer hosting the WSL instance, with the
board available as a USB device on that computer. If WSL is inside a remote
Dev Box, first read [Remote Dev Box USB](#remote-dev-box-usb).

Use a USB data cable, not a charge-only cable. Keep a WSL terminal open while
attaching the device.

In Administrator PowerShell, find the board and share it:

```powershell
usbipd list
usbipd bind --busid <BUSID>
```

Replace `<BUSID>` with the actual bus ID from the list. Then attach it from
PowerShell; this step does not normally require administrator privileges:

```powershell
usbipd attach --wsl --busid <BUSID>
```

Inside WSL, verify the connection and inspect serial ports:

```bash
lsusb
ls /dev/ttyACM* /dev/ttyUSB*
sudo usermod -aG dialout "$USER"
```

An unmatched serial-port pattern may print `No such file or directory`; only
one family of ports may be present. Group membership changes require a new
login session. Reconnect VS Code to WSL and check `id -nG` before retrying access.

- Native ESP32-S3 USB Serial/JTAG normally appears as `/dev/ttyACM0`.
- A USB-to-UART bridge such as CP210x or CH34x normally appears as `/dev/ttyUSB0`.
- These are examples, not guaranteed device names. Select the actual port shown
  on your machine.
- While attached to WSL, the device is unavailable to Windows applications.
- After unplugging, resetting into another USB mode, or restarting WSL, check
  `usbipd list` and reattach as needed. The bus ID or device identity may change.

To return the device to Windows, run in PowerShell:

```powershell
usbipd detach --busid <BUSID>
```

For built-in JTAG debugging, use the board connector wired to the ESP32-S3's
native USB D+/D- pins, not just the UART bridge. No external JTAG adapter is
needed when that native connection is exposed and available. OpenOCD may also
require its supplied udev rules for non-root USB access; serial `dialout`
membership alone does not grant raw USB JTAG access. Follow the official WSL and
JTAG guides rather than running the development tools as root.

## Remote Dev Box USB

This workspace runs in WSL on a remote Windows Dev Box, accessed through Windows
App on a local Windows 11 computer. The reported board name is ESP32-S3 Nano.
USB support is assumed for planning; the manufacturer, USB interface, flash, and
PSRAM details have not been verified. Do not infer those settings from the name.

There are two separate forwarding stages:

```text
Board connected to local Windows PC
  -> Windows App / RDP USB redirection
  -> Remote Windows Dev Box
  -> usbipd-win, if the redirected device is supported
  -> Ubuntu in WSL on the Dev Box
```

The first stage does not automatically provide the second. An RDP-redirected
COM port alone is not a USB device that WSL can attach, and it does not provide
USB-JTAG. Even low-level USB redirection must be tested for compatibility with
`usbipd-win`; this complete chain is not yet verified.

### 1. Make the Board Visible on the Dev Box

1. Connect the board to the local Windows 11 PC with a USB data cable and confirm
  it appears in local Device Manager.
2. Ask your administrator to permit supported low-level USB redirection on both
  computers. The local policy is **Allow RDP redirection of other supported
  RemoteFX USB devices from this computer**. The Dev Box policy **Do not allow
  supported Plug and Play device redirection** must not block it. Follow the
  linked Microsoft guide for policy values and any required restarts; do not
  override organization-managed restrictions.
3. Reconnect with Windows App. If available, use the full-screen connection bar's
  device-redirection control to select only the board. If the control or board
  is absent, resolve client support, device support, and policy first.
4. Confirm the board appears without driver errors in Device Manager on the
  remote Dev Box. A COM port listing alone does not prove low-level USB
  redirection is working.

### 2. Test Forwarding from the Dev Box into WSL

The initial checks found no `usbipd-win` command or service on the Dev Box.
After the first stage works, install it in Windows on the Dev Box, with
administrator approval, using PowerShell:

```powershell
winget install --interactive --exact dorssel.usbipd-win
```

Open a new PowerShell window on the Dev Box and run:

```powershell
usbipd list
```

Continue only if this lists the board with a usable bus ID. Use that Dev Box bus
ID with the `bind` and `attach --wsl` commands in step 5 above. Do not use a bus
ID obtained on the local PC. Installing or running `usbipd attach --wsl` on the
local PC targets local WSL, not the remote Dev Box's WSL instance.

In Ubuntu on the Dev Box, install `usbutils` if `lsusb` is missing, then verify:

```bash
sudo apt-get install --yes usbutils
lsusb
ls /dev/ttyACM* /dev/ttyUSB*
```

Complete the serial permissions setup from step 5. USB-JTAG additionally needs
appropriate OpenOCD USB permissions. Recheck both forwarding stages after a
device reset, USB mode change, unplug, or remote-session disconnect.

If the board is absent from `usbipd list` or cannot be attached, stop there;
visibility in remote Windows does not guarantee re-export into WSL. Prefer
building on the Dev Box and flashing/monitoring on the local PC, or running WSL
locally beside the board. Low-level RDP USB redirection is designed for
low-latency LAN connections, so remote flashing can be unreliable even when
enumeration succeeds.

Do not expose USB/IP TCP port 3240 to the public Internet. The installer adds a
firewall rule; keep access limited to trusted clients according to your
organization's policy. A dedicated USB-over-network route would need separate
network and security planning.

## Post-Installation Verification

Wait until EIM reports a successful installation before running these checks.
Passed prerequisites and accepted chip/version selections do not mean the SDK
installation has finished. An empty EIM installation registry while downloads
or installation are still in progress does not by itself indicate a failure.

The following checks do not require a connected board or WSL USB forwarding.

### 1. Verify VS Code Configuration

In the VS Code WSL window, open the Command Palette with `Ctrl+Shift+P`:

1. Run `ESP-IDF: Select Current ESP-IDF Version` and select the installed v6.1
  setup, or the explicitly chosen compatible release for your board's BSP.
2. Run `ESP-IDF: Doctor Command`.

Check the report for missing tools, invalid SDK paths, or Python environment
errors. If the installation is not listed after EIM reports success, check EIM's
final output and the extension's installation detection before proceeding.
A disconnected board does not prevent software-only verification.

### 2. Verify the Toolchain

Run `ESP-IDF: Open ESP-IDF Terminal` from the Command Palette after selecting
the installation. In that terminal, run:

```bash
idf.py --version
idf.py --list-targets
cmake --version
ninja --version
xtensa-esp-elf-gcc --version
openocd --version
```

Expected results:

- ESP-IDF reports v6.1, or the exact compatible release deliberately selected.
- The supported target list includes `esp32s3`.
- CMake, Ninja, the Xtensa compiler, and OpenOCD each print a version without
  errors. Their versions should be compatible with the selected ESP-IDF setup;
  they do not share ESP-IDF's version number.

Use the ESP-IDF terminal because it activates the selected SDK's environment.
An ordinary terminal can report `command not found` even after a successful
installation. If that happens, select the installation and open a new ESP-IDF
terminal before treating it as an installation failure.

CMake configures the build and Ninja runs compilation; `idf.py build` drives
both. Use the ESP-IDF extension's build workflow without configuring a separate
CMake Tools kit.

### 3. Compile a Hello-World Example

The repository now contains a minimal application that logs a hello-world
message once per second. Its tracked defaults select `esp32s3`, and it has built
successfully with ESP-IDF v6.1. From an activated ESP-IDF terminal in this
repository, run:

```bash
idf.py build
```

This command uses the current generated `sdkconfig`. A fresh configuration
selects the generic profile and leaves GPIO48 untouched. For the XinluCity
ESP32S3 NANO G48 feature, explicitly select and verify the board profile using
the [optional board status LED build instructions](../README.md#optional-board-status-led)
before flashing.

Fresh project configurations also use the tracked compiler size-optimization
default. Existing generated configurations keep their prior selection, so
verify `COMPILER_OPTIMIZATION_SIZE=true` in `build/config/sdkconfig.json` before
comparing image headroom. Selecting the debug optimization profile is valid for
debugging, but produces a larger image and can restore the low-headroom warning.

Alternatively, use a separate official example to test the installation:

1. Run `ESP-IDF: Show Examples Projects`, choose the installed ESP-IDF version,
  and select `get-started/hello_world`.
2. Create the example in a new folder outside this repository and the SDK
  installation, such as `~/esp/hello_world_check`. Do not build directly in the
  SDK's example directory or overwrite the project scaffold.
3. Open the example in a VS Code WSL window, select the same ESP-IDF installation
  if needed, and open an ESP-IDF terminal at the example's project root.
4. Run:

```bash
idf.py set-target esp32s3
idf.py build
```

Look for `Project build complete` and a successful command exit. This checks
SDK configuration, compilation, linking, and firmware image generation without
requiring a board.

Set the target once for this new example. Repeating `set-target` clears the
build configuration, so subsequent builds should use only `idf.py build`.
Selecting `all` chips in EIM installs extra tools but does not select the
application target or make this ESP32-S3 build slower.

Installation verification is complete when the SDK selection, tool checks, and
example build succeed. Flashing, serial output, and JTAG are separate hardware
checks; continue with the [first acceptance test](#first-acceptance-test) after
identifying the board and forwarding its USB connection to WSL.

### 4. Verify C/C++ IntelliSense

ESP-IDF generates `build/compile_commands.json` during the build. It records the
compiler, include paths, and definitions for each firmware source file. The
native test runner similarly generates `.cache/tests/compile_commands.json` for
host-compiled test sources. Run it once to create that database:

```bash
node tools/test-native.mjs
```

Configure Microsoft C/C++ to use both databases in the workspace's VS Code
settings, preserving other settings already present:

```json
{
  "C_Cpp.default.compileCommands": [
    "${workspaceFolder}/build/compile_commands.json",
    "${workspaceFolder}/.cache/tests/compile_commands.json"
  ]
}
```

The repository ignores machine-specific `.vscode/settings.json`, so apply this
setting locally. After a successful firmware build and native test run, open
`main/app_main.c` and a file under `components/*/test/`; check that their SDK,
FreeRTOS, and host-test includes have no missing-header diagnostics.

After a fresh clone or deleting generated directories, run `idf.py build` and
`node tools/test-native.mjs` to regenerate both databases. If diagnostics
remain, check that the appropriate database contains the source file and that
any selected C/C++ configuration provider is not overriding it. Do not silence
diagnostics or manually copy SDK headers into the project.

## Proposed Repository Structure

This is the intended layout as features are added, not a requirement to create
every file immediately. The root build definition, `main` application, and target
defaults are in place. Add board components, tests, and CI when they have an
actual role.

```text
remote-keyboard-connector/
|-- .github/
|   `-- workflows/
|       `-- build.yml
|-- .vscode/
|   |-- extensions.json
|   `-- settings.json
|-- main/
|   |-- CMakeLists.txt
|   `-- app_main.c
|-- components/
|   `-- board/
|       |-- CMakeLists.txt
|       |-- include/
|       |   `-- board.h
|       |-- board.c
|       `-- test/
|           |-- CMakeLists.txt
|           `-- test_board.c
|-- docs/
|   |-- development-setup.md
|   `-- architecture.md
|-- hardware/
|   |-- README.md
|   `-- pinout.md
|-- tools/
|-- CMakeLists.txt
|-- sdkconfig.defaults
|-- sdkconfig.defaults.esp32s3
|-- partitions.csv
|-- dependencies.lock
|-- .clang-format
|-- .editorconfig
|-- .gitignore
|-- README.md
`-- LICENSE
```

### Directory Responsibilities

| Directory | Purpose |
| --- | --- |
| `main/` | Application entry point, board initialization, and task startup |
| `components/` | Cohesive reusable hardware and application modules |
| `components/board/include/` | Public board interface once the hardware is known |
| `components/board/test/` | Board-component tests, added with the implementation |
| `docs/` | Development setup, architecture, and design decisions |
| `hardware/` | Exact board identification, pin maps, wiring, and hardware references |
| `tools/` | Project-specific helper scripts when needed |
| `.vscode/` | Portable extension recommendations and shared editor configuration |
| `.github/workflows/` | Firmware/native and browser CI for PRs, main pushes, and manual runs |

Keep `main` small: initialize the board and start application tasks there. Add
one cohesive component per device or feature, such as `status_led`,
`sensor_bme280`, `wifi_manager`, or `storage`, instead of a large generic drivers
directory. Use component-local `include/` and `test/` directories as needed.

Add `idf_component.yml` within a component, including `main`, when declaring
managed dependencies. Let the Component Manager generate `dependencies.lock`;
do not hand-write an empty lock file. A custom partition table is optional and
should wait until the actual flash capacity and storage or OTA needs are known.
Choose a license explicitly before adding its text.

### Git Conventions

- Track source, CMake files, component manifests, `sdkconfig.defaults*`, any
  custom partition table, and `dependencies.lock` once generated.
- For this starter, treat `sdkconfig` as local generated configuration. After
  changing intended shared settings with `idf.py menuconfig`, use
  `idf.py save-defconfig` and review the resulting defaults before committing.
- Defaults seed new configuration; they do not automatically replace every
  existing value in a local `sdkconfig`.
- Ignore `build/`, `managed_components/`, `sdkconfig`, `sdkconfig.old`, local
  environments, and editor caches. Do not edit downloaded managed components.
- Do not commit Wi-Fi passwords, private keys, tokens, or provisioning data.
  Review staged changes; ignore rules are not a substitute for checking secrets.
- Keep absolute SDK paths and serial ports out of shared VS Code settings.
- Empty directories need a tracked placeholder such as `.gitkeep` to survive a
  future Git clone. Replace placeholders when real files are added.
- Add a GitHub build workflow after the local build works. Use the same exact
  ESP-IDF release locally and in CI. A hosted compile check does not verify the
  physical board, flashing, or peripheral behavior.

## First Acceptance Test

The first board smoke test is passed based on the user's 2026-09-14 report:
both the separate-image ZIP and merged BIN were tried on the board and worked.
The earlier local esptool v5.4.0 connection identified ESP32-S3 v0.2 on COM4,
native USB Serial/JTAG, 8 MB PSRAM, and a 40 MHz crystal. See the hardware record
for the reported details. Local COM4 access does not establish remote WSL USB
forwarding.

The packaged DIO/80 MHz/2 MB configuration was reported working, but physical
flash capacity, board power limits, and a tested ROM recovery/logging procedure
remain undocumented. PSRAM capacity does not establish flash capacity. Preserve
the working settings; do not infer a complete board profile from the smoke test.

Run in the activated ESP-IDF terminal at the application root:

```bash
idf.py --version
idf.py build
```

Once those hardware checks are complete, select the actual download/UART port
for flashing instead of assuming `/dev/ttyACM0`. The target is already selected;
do not rerun `set-target` as part of the incremental build loop.

Native USB HID and USB Serial/JTAG share the S3 PHY. Do not expect the native
serial monitor to remain available after this image boots into HID. Use a
verified separate UART logging connection, or validate a standalone SDK
hello-world image separately when establishing the initial recovery path.

Detailed acceptance for the current image includes USB keyboard enumeration, joining its
protected AP, loading the local page, and observing typing/Shift/Caps reports
from physical keyboard, mouse, and touch actions. Test focus/network loss while
holding keys and unplug/replug recovery. See the enhancement plan for pending checks.
The successful board report did not provide per-check results or measurements;
it does not mark this detailed acceptance matrix complete.

## Hardware Decisions Still Needed

- Exact board manufacturer, model, and revision.
- ESP32-S3 module variant and flash capacity.
- PSRAM interface mode/timing; 8 MB capacity was reported by esptool.
- Other USB connector roles; the tested connection reported native Serial/JTAG.
- Board pin map, onboard LED type, and connected peripherals.
- Power limits, ROM recovery/logging procedure, and any required vendor BSP.

These choices determine the pin map, SDK compatibility, flash and PSRAM
configuration, console, and eventual partition layout.

## Official References

- [ESP32-S3 Get Started](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/index.html)
- [ESP-IDF Version Selection and Support](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/versions.html)
- [Install ESP-IDF and Tools in VS Code](https://docs.espressif.com/projects/vscode-esp-idf-extension/en/latest/installation.html)
- [ESP-IDF VS Code with WSL](https://docs.espressif.com/projects/vscode-esp-idf-extension/en/latest/additionalfeatures/wsl.html)
- [Microsoft WSL USB Forwarding](https://learn.microsoft.com/windows/wsl/connect-usb)
- [Windows App Redirection Support](https://learn.microsoft.com/en-us/windows-app/compare-platforms-features#redirection)
- [Microsoft Dev Box USB Redirection](https://learn.microsoft.com/en-us/azure/virtual-desktop/redirection-configure-usb?pivots=dev-box)
- [usbipd-win WSL Support](https://github.com/dorssel/usbipd-win/wiki/WSL-support)
- [ESP-IDF Build System and Components](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/build-system.html)
- [ESP32-S3 JTAG Debugging](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/jtag-debugging/index.html)