# Flash The Keyboard Locally On Windows

This bundle contains the enhanced iPhone-style US typing keyboard firmware for
ESP32-S3, not the Node.js preview. Windows needs Python and esptool v5.4.0 (the
version used in your successful connection test); ESP-IDF and Node.js are not
needed on the flashing machine. Use a consenting, non-sensitive test host.

## Before Writing Flash

1. Extract the entire ZIP, preserving its folders. Open PowerShell in the
   extracted `wifi-keyboard-esp32s3` directory beside `flash_args`.
2. Confirm the board's ROM download/recovery procedure and a suitable USB cable
   and power arrangement. Native USB Serial/JTAG can disappear after HID starts,
   so recovery must not depend on the running application exposing COM4.
3. Close serial monitors or other software using the board's port. Use the
   current COM port if it has changed since the successful COM4 test.
4. Check flash identity with the same esptool installation used for that test:

   ```powershell
   py -m esptool --chip esp32s3 --port COM4 flash-id
   ```

   This reads identification and may reset the chip; it does not write firmware.
   If your working command was `esptool` rather than `py -m esptool`, use that
   executable prefix for the commands below as well. Do not install or select
   another Python environment merely to match these examples.

The current package preserves the build's **2 MB flash, DIO, 80 MHz** settings.
Check `manifest.json` for the packaged settings. The reported **8 MB PSRAM is not
flash capacity**. Do not flash a device with less than the configured capacity
or assume the detected size proves its flash mode/frequency compatibility.
Larger physical flash does not require using all of it, but keep this package's
settings unchanged until the board configuration is verified. PSRAM is not
required by this build. Detailed USB/power acceptance remains pending beyond the
user-reported successful board smoke test recorded below.

Do not use this generic bundle on a device with secure boot or flash encryption
enabled without its established signed/encrypted flashing procedure. Do not
burn eFuses, disable security, or use a force/whole-chip-erase option.

## Verify Package Integrity

Optionally verify the ZIP before extraction with `Get-FileHash` and compare it
with the supplied `firmware-package.zip.sha256`. Then check all files listed in
the extracted manifest:

```powershell
$manifest = Get-Content .\manifest.json -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    $actual = (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash
    if ($actual -ne $file.sha256) { throw "Checksum mismatch: $($file.path)" }
}
Write-Host "All packaged file checksums match."
```

Checksums detect transfer corruption; they are not a signed firmware identity.
Do not proceed after a mismatch.

## Preserve Existing Firmware

Flashing replaces the bootloader, partition table, and application at the listed
offsets. Back up any firmware or data that must be retained. Enter the flash size
in MB shown by `flash-id`, not the PSRAM size or this build's configured size:

```powershell
$FlashMiB = [int](Read-Host "Detected flash size in MB from flash-id")
if ($FlashMiB -notin @(1, 2, 4, 8, 16, 32, 64, 128)) { throw "Check the detected flash size." }
$FlashBytes = $FlashMiB * 1MB
py -m esptool --chip esp32s3 --port COM4 read-flash 0 $FlashBytes before-keyboard.bin
```

Keep the backup private: it may contain credentials from the previous firmware.
The package writes separate images, not a merged image filling every gap, and
does not request a whole-chip erase. That is not a guarantee of compatibility
with data or partitions from an unrelated previous application.

## Flash

Only after flash settings, recovery, backups, and package integrity are checked,
run from the extracted package directory:

```powershell
py -m esptool --chip esp32s3 --port COM4 --baud 460800 --before default-reset --after hard-reset write-flash "@flash_args"
```

Keep the quotes around `@flash_args` in PowerShell. The argument file supplies
the build-generated flash settings and all required images; do not flash only
the application binary onto a board that lacks the matching bootloader/table.

| Offset | Image |
| --- | --- |
| `0x0` | `bootloader/bootloader.bin` |
| `0x8000` | `partition_table/partition-table.bin` |
| `0x10000` | `esp32s3_starter.bin` |

`manifest.json` records the exact filenames, offsets, sizes, and SHA-256 values.
esptool verifies the written image data during flashing. Wait for its successful
completion; do not disconnect the cable while it is writing. A connection error
is not a reason to erase flash or change eFuses. Recheck the port and enter the
board's documented ROM download mode; recovery may enumerate at a different port.

## First Run

- After reset, native USB should enumerate as a keyboard, not the previous
  USB Serial/JTAG port. COM4 disappearing at this point can be expected. Keep a
  separate verified UART logging path if runtime logs are needed.
- Join `WiFiKeyboard-<last-six-MAC-hex-digits>` from the controller. The public
  development password is `a-key-test-only` for the current default build;
  `manifest.json` indicates if a custom password was used instead.
- Open `http://192.168.4.1/` in a full browser. No router, Wi-Fi setup page,
  login, or Internet connection is required. Only one controller is supported.
- In a test editor on the USB host, check typing, Shift, symbols, Caps feedback,
  and releases with mouse, touch, and physical keyboard. There is no automatic
  typing on connection. Use the on-page release button or unplug USB to stop.
- Test focus loss, Wi-Fi loss while holding a key, and unplug/replug recovery.
  Host layout and lock state determine the actual text; `queued` input replies
  are not proof of USB completion or text appearing in an application.

This is an unauthenticated HTTP/WS development prototype. Anyone with AP access
can control the keyboard. Packaging is an offline operation and does not itself
flash a device. Do not expose the prototype to an untrusted network or use it on
a sensitive host.

## Hardware Status

On 2026-09-14 the user confirmed that both the separate-image ZIP and merged BIN
worked on their ESP32-S3 board. Both flashing formats therefore have a
user-reported hardware smoke-test pass. They contain the same keyboard firmware;
this report does not establish a different feature set for either format.

The user did not provide a per-feature matrix, host/controller OS details, USB
captures, or timing/power measurements. Detailed input and release safety tests,
suspend/resume behavior, endurance, recovery, and cross-platform compatibility
remain separate checks. The source workspace's hardware record contains the
reported chip details and test history. No firmware settings or binaries were
changed as part of this status confirmation.