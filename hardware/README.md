# Hardware

## Seeed Studio XIAO ESP32S3

The standard XIAO ESP32S3 profile targets 8 MiB flash, not the newer 16 MiB Plus.
[Seeed's documentation](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/)
lists 8 MiB flash and 8 MiB PSRAM for the standard board. The firmware does not
require or enable PSRAM. The profile uses native ESP32-S3 USB HID, two 3.875 MiB
OTA slots, and the initial mDNS name `x.local`. Owner renames remain persistent.

The LED/sleep follow-up controls the active-low yellow GPIO21 user LED and
supports GPIO0 BOOT wake. Fresh XIAO sleep settings default to Never; owners
can save 30 or 60 minutes. The user LED pulses for 100 ms every two seconds
when ready/idle, stays ON for active control, and stays OFF when not ready.
During deep sleep, GPIO21 is held HIGH/off; actual sleep darkness and wake
behavior still require on-board acceptance. GPIO48 and the battery-charge
indicator remain untouched. GPIO19/GPIO20 remain reserved for native USB.

The official [v1.2 schematic](https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/res/XIAO_ESP32S3_SCH_v1.2.pdf)
was reviewed on 2026-10-05: `VCC_3V3 -> R15 (1.5 kOhm) -> D3 (yellow) ->
IO21/USER_LED`, BOOT pulls GPIO0 to ground with a 10 kOhm external pull-up,
and RESET controls EN. The exact physical revision remains unconfirmed.
Use the supplied external antenna; successful communication without one does
not establish a reliable Wi-Fi link.

The XIAO was initially absent from the Linux/WSL development environment.
After USB passthrough, read-only enumeration showed an Espressif USB
JTAG/serial debug unit (`303a:1001`) at `/dev/ttyACM0`. The assistant refreshed
and verified the installation bundle offline but did not reset or flash the
board; first-install instructions were provided for user execution.

### XIAO Hardware Test Status

| Date | Check | Result and evidence |
| --- | --- | --- |
| 2026-10-05 | Basic connection and USB typing after first-install guidance | Passed, user reported: "connected and typing is fine." This confirms a basic end-to-end hardware smoke test, not the full acceptance matrix. The exact installed-image hash, host/controller OS, and connection address were not independently confirmed. |
| 2026-10-05 | Page-loading improvement with supplied antenna | Passed, user reported immediate page loading after attaching the antenna. Before attachment, WSL measurements showed approximately 2.4 seconds for a 39 KB script even over the direct IP. No post-attachment instrumented timings or RF measurements were supplied. |
| 2026-10-05 | Physical `x.local` resolution, BOOT/RESET recovery, OTA/rollback, key/modifier and release behavior, USB suspend/resume, and endurance | Pending separate checks. Successful connection and typing alone do not establish these results. |
| 2026-10-05 | New GPIO21 status patterns, dark sleep, BOOT wake, and persisted opt-in idle timeout | Pending. The LED/sleep follow-up has not been flashed by the assistant; earlier typing/antenna checks do not establish acceptance of this new firmware. |

Software validation on 2026-10-05 passed XIAO, generic, and XinluCity ESP-IDF
v6.1 builds and offline signed-artifact verification. The XIAO application is
1,052,672 signed bytes, leaving 74% of each 3.875 MiB OTA slot free. The software
checks passed 26 native suites with ASan/UBSan, 91 Python installer/artifact
tests, 13 Node provisioning/installer tests, and nine focused Chromium/WebKit
network/UI tests, including `x.local` rendering and persistent owner renames.
CI workflow YAML and its embedded profile-check Python were syntax-validated;
the updated GitHub workflow itself has not been run remotely.

## XinluCity ESP32S3 NANO

The LED/sleep follow-up also changes fresh XinluCity timeout settings to Never,
matching XIAO; owners can still save 30 or 60 minutes. Existing saved settings
remain unchanged. Both boards share the updated not-ready OFF pattern. The
historical results below describe previously installed firmware, not physical
acceptance of this follow-up.

The user-supplied XinluCity resources identify the intended board as ESP32S3
NANO / ESP32-S3-N16R8. The vendor schematic was reviewed on 2026-09-15; exact
PCB revision remains unverified. Local Windows checks subsequently confirmed
the chip, flash capacity, USB modes, and core visible G48 status patterns. The
table distinguishes user-observed physical behavior from vendor specifications
and remaining acceptance work.

| Item | Value |
| --- | --- |
| Manufacturer and board model | XinluCity ESP32S3 NANO / ESP32-S3-N16R8, from user-supplied vendor resources |
| Board revision | To be confirmed |
| Chip and silicon revision | ESP32-S3 v0.2, reported by esptool |
| Chip package | QFN56, reported |
| Chip features | Wi-Fi, Bluetooth LE, dual core, 240 MHz, reported |
| Crystal frequency | 40 MHz, reported |
| ESP32-S3 module variant | To be confirmed |
| Physical flash capacity | 16 MB, confirmed by esptool flash ID/capacity detection on 2026-09-15 |
| Tested firmware flash settings | 2 MB configured size, DIO, 80 MHz; both packaged formats reported working |
| PSRAM capacity and mode | 8 MB reported; interface mode/timing unconfirmed; current firmware does not require PSRAM |
| Connected USB interface | ROM download mode: native USB Serial/JTAG; running application: USB HID keyboard |
| Local download connection | COM4 on local Windows, successful with esptool v5.4.0 |
| Other USB connectors | To be confirmed |
| UART bridge chip, if present | To be confirmed |
| Onboard LED type and GPIO | Vendor schematic: fixed 3V3 PWR and discrete single-color, active-low G48 on GPIO48; core visible G48 patterns physically passed, without instrumented electrical-level measurement |
| Attached peripherals and pin assignments | To be confirmed |
| Vendor product page and schematic | [Reviewed vendor resources](../docs/board-status-led-proposal.md#verified-board-wiring) |
| Vendor BSP and compatible ESP-IDF release | To be confirmed |
| Intended application | Wi-Fi browser-controlled USB typing keyboard |

## Hardware Test Status

| Date | Check | Result and evidence |
| --- | --- | --- |
| 2026-09-14 | Local chip connection | Passed, user-reported esptool v5.4.0 detection on COM4 with the chip details above. |
| 2026-09-14 | Separate-image ZIP flashing and operation | Passed, user reported the packaged bootloader, partition table, and application worked on the board. |
| 2026-09-14 | Merged BIN flashing and operation | Passed, user reported the merged image worked on the board. |
| 2026-09-15 | G48 ready/idle, active-control, and release patterns | Passed on the explicitly flashed `0xf6920` (1,009,952-byte) debug-optimized XinluCity-profile image. The user observed one short pulse about every two seconds while ready/idle, steady ON with a valid controller, and return to the idle pulse after Release with no stuck key. Full image readback matched the authorized build. |
| 2026-09-15 | G48 startup/not-ready, AP-only, reconnect, USB unplug/suspend, focus/network loss, timing/load, and endurance | Pending. The size-optimized `0xe17c0` image was build-validated but not physically flashed. |
| 2026-09-18 | Automatic idle sleep and BOOT recovery | User confirmed sleep after more than 30 minutes idle and return after pressing BOOT. This is a user-observed functional check, without current measurements or exact installed-image identification. |
| 2026-09-18 | G48 dark during sleep | Failed on both PC and iPad: the user observed G48 green instead of dark while the board slept. The high-impedance sleep-state correction is software-tested but requires a new on-board check. |

The user confirmed: "I've tried both versions on board, worked perfectly fine."
Both formats contain the same keyboard firmware. Record this as a basic
real-board smoke-test pass for both flashing methods, not as completion of every
acceptance test in the design specification. No per-feature results, USB captures,
timing measurements, or exact host/controller OS details accompanied the report.

Detailed key/Shift/Caps and input-method coverage, release on focus/network loss,
USB reset/suspend/resume, endurance, power compliance, and the PC/Mac/iPhone/iPad
compatibility matrix remain to be recorded separately. ROM recovery and local
COM4 access passed on Windows; this does not establish remote WSL USB access.
Silicon revision is not PCB revision, and PSRAM capacity is not flash capacity.

## Status LED Wiring

The vendor schematic shows `3V3 -> R13 (4.7 kOhm) -> PWR -> GND` and
`3V3 -> LED1 -> R25 (4.7 kOhm) -> GPIO48`. PWR is not software-controlled;
G48 is illuminated by LOW and dark at HIGH. It is not an addressable RGB LED.

The HIGH/off relationship above describes powered, awake operation. The initial
power-management implementation retained a driven HIGH output during deep sleep,
but the user observed the LED lit while sleep and BOOT wake still worked. The
candidate correction releases GPIO48's input, output, and both pulls before
holding the pin state through sleep. It does not change pad supply selection,
flash/PSRAM power settings, the idle timeout, or the BOOT wake source.

High impedance disables the GPIO drivers, not the pad's protection paths; it
does not establish that any supply-related leakage is eliminated. GPIO48's
actual supply selection and sleep voltage remain unmeasured. Confirm the LED
is dark and BOOT still restores normal operation on the corrected test image
before accepting this fix. If it remains lit, investigate the pin supply and
board circuit rather than changing shared memory-pad supplies speculatively.

The [board status implementation](../docs/board-status-led-proposal.md#software-implementation-record)
requires the explicit XinluCity profile and leaves PWR, USB GPIO19/GPIO20, and
flash/PSRAM settings untouched. Generic builds leave GPIO48 untouched too.
A separately approved physical check confirmed the visible ready/idle,
active-control, and release-to-idle behavior on the actual board. It did not
instrument GPIO voltage/polarity or complete the remaining status and load
matrix above.

Do not assume all ESP32-S3 boards share this LED pin, flash size, PSRAM, or USB
connection. Confirm the remaining pin assignments against the physical board
and its schematic before use.

See the [development setup guide](../docs/development-setup.md) for WSL USB
forwarding and the first hardware acceptance test.