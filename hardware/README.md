# Hardware

The exact board vendor/model remains unconfirmed. On 2026-09-14 the user
reported successful local detection and subsequently confirmed that both firmware
package formats worked on the board. The results below are user-reported hardware
observations, not measurements made from this remote WSL workspace.

| Item | Value |
| --- | --- |
| Manufacturer and board model | To be confirmed |
| Board revision | To be confirmed |
| Chip and silicon revision | ESP32-S3 v0.2, reported by esptool |
| Chip package | QFN56, reported |
| Chip features | Wi-Fi, Bluetooth LE, dual core, 240 MHz, reported |
| Crystal frequency | 40 MHz, reported |
| ESP32-S3 module variant | To be confirmed |
| Physical flash capacity | To be confirmed; not inferred from PSRAM |
| Tested firmware flash settings | 2 MB configured size, DIO, 80 MHz; both packaged formats reported working |
| PSRAM capacity and mode | 8 MB reported; interface mode/timing unconfirmed; current firmware does not require PSRAM |
| Connected USB interface | Native USB Serial/JTAG reported during the connection check |
| Local download connection | COM4 on local Windows, successful with esptool v5.4.0 |
| Other USB connectors | To be confirmed |
| UART bridge chip, if present | To be confirmed |
| Onboard LED type and GPIO | To be confirmed |
| Attached peripherals and pin assignments | To be confirmed |
| Vendor product page and schematic | To be confirmed |
| Vendor BSP and compatible ESP-IDF release | To be confirmed |
| Intended application | Wi-Fi browser-controlled USB typing keyboard |

## Hardware Test Status

| Date | Check | Result and evidence |
| --- | --- | --- |
| 2026-09-14 | Local chip connection | Passed, user-reported esptool v5.4.0 detection on COM4 with the chip details above. |
| 2026-09-14 | Separate-image ZIP flashing and operation | Passed, user reported the packaged bootloader, partition table, and application worked on the board. |
| 2026-09-14 | Merged BIN flashing and operation | Passed, user reported the merged image worked on the board. |

The user confirmed: "I've tried both versions on board, worked perfectly fine."
Both formats contain the same keyboard firmware. Record this as a basic
real-board smoke-test pass for both flashing methods, not as completion of every
acceptance test in the design specification. No per-feature results, USB captures,
timing measurements, or exact host/controller OS details accompanied the report.

Detailed key/Shift/Caps and input-method coverage, release on focus/network loss,
USB reset/suspend/resume, endurance, power compliance, ROM recovery, and the
PC/Mac/iPhone/iPad compatibility matrix remain to be recorded separately. The
successful report does not establish remote WSL access to local COM4 or the
board's physical flash capacity. Silicon revision is not PCB revision, and
PSRAM capacity is not flash capacity.

Add pinout and wiring documentation here once the hardware is known. Do not
assume that all ESP32-S3 boards share the same LED pin, flash size, PSRAM, or USB
connection. Check the vendor schematic before assigning pins.

See the [development setup guide](../docs/development-setup.md) for WSL USB
forwarding and the first hardware acceptance test.