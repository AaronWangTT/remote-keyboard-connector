# Hardware

The user-supplied XinluCity resources identify the intended board as ESP32S3
NANO / ESP32-S3-N16R8. The vendor schematic was reviewed on 2026-09-15; exact
PCB revision and physical LED behavior remain unverified. On 2026-09-14 the
user reported successful local detection and confirmed that both earlier
firmware package formats worked. The table distinguishes those user reports
from vendor specifications; neither is a measurement from this remote WSL workspace.

| Item | Value |
| --- | --- |
| Manufacturer and board model | XinluCity ESP32S3 NANO / ESP32-S3-N16R8, from user-supplied vendor resources |
| Board revision | To be confirmed |
| Chip and silicon revision | ESP32-S3 v0.2, reported by esptool |
| Chip package | QFN56, reported |
| Chip features | Wi-Fi, Bluetooth LE, dual core, 240 MHz, reported |
| Crystal frequency | 40 MHz, reported |
| ESP32-S3 module variant | To be confirmed |
| Physical flash capacity | Vendor specifies 16 MB; an actual flash-ID/capacity check remains to be recorded |
| Tested firmware flash settings | 2 MB configured size, DIO, 80 MHz; both packaged formats reported working |
| PSRAM capacity and mode | 8 MB reported; interface mode/timing unconfirmed; current firmware does not require PSRAM |
| Connected USB interface | Native USB Serial/JTAG reported during the connection check |
| Local download connection | COM4 on local Windows, successful with esptool v5.4.0 |
| Other USB connectors | To be confirmed |
| UART bridge chip, if present | To be confirmed |
| Onboard LED type and GPIO | Vendor schematic: fixed 3V3 PWR and discrete single-color, active-low G48 on GPIO48; physical polarity/pattern checks pending |
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
| 2026-09-15 | G48 polarity, patterns, state-change timing, and USB/load behavior | Pending. Native mocks and firmware builds are software evidence only; no LED firmware was written or physically tested. |

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

## Status LED Wiring

The vendor schematic shows `3V3 -> R13 (4.7 kOhm) -> PWR -> GND` and
`3V3 -> LED1 -> R25 (4.7 kOhm) -> GPIO48`. PWR is not software-controlled;
G48 is illuminated by LOW and dark at HIGH. It is not an addressable RGB LED.

The [board status implementation](../docs/board-status-led-proposal.md#software-implementation-record)
requires the explicit XinluCity profile and leaves PWR, USB GPIO19/GPIO20, and
flash/PSRAM settings untouched. Generic builds leave GPIO48 untouched too.
Only a separately approved physical check can confirm that the actual board
matches this circuit and that the patterns and input-release behavior are correct.

Do not assume all ESP32-S3 boards share this LED pin, flash size, PSRAM, or USB
connection. Confirm the remaining pin assignments against the physical board
and its schematic before use.

See the [development setup guide](../docs/development-setup.md) for WSL USB
forwarding and the first hardware acceptance test.