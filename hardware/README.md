# Hardware

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