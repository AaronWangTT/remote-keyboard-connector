# Sender Installation And Firmware Artifacts

The sender installs and tests each ESP32-S3 before shipping. Recipients only
need the private setup card and a browser. Installation is a separate, explicit
device operation, never part of a firmware build or CI upload.

## Public Firmware And Private Installation Files

CI uploads three separate images, generated `flasher_args.json` and `flash_args`,
`firmware-manifest.json` with hashes and build-security settings, and a build
summary. GitHub Actions wraps these files in its download archive.
There is no nested custom firmware ZIP, merged BIN, or per-device NVS image.
Extract the complete artifact and use its `build` directory as `--firmware`.
Use a trusted artifact and a trusted checkout of the matching installer revision.
The artifact alone is not a standalone installer; the sender needs the repository
tools and SDK environment below.
Older artifacts without the manifest are refused: rebuild them from trusted
source. Do not fabricate a manifest to bypass security checks.

The sender command creates a different, private per-device directory outside
the repository. It includes a firmware snapshot, identity CSV/BIN, Wi-Fi QR,
printable setup card, install plan with SHA-256 hashes, and a full-flash backup.
These files contain credentials or device data. Never upload them to Git,
Actions artifacts, issue attachments, or shared logs. Checksums detect changed
bytes; they are not signatures or evidence of hardware compatibility.

Merged images are deliberately excluded. Writing their padded gaps can overwrite
NVS, including ownership and recovery credentials. The installer uses one sparse
esptool write containing only the three firmware images and the NVS image.

## Prerequisites

- Use Node.js 22 and an activated ESP-IDF v6.1 terminal. The SDK Python needs
  validated esptool 5.3.1 (the pinned CI image) or 5.4.0 (the local SDK), plus
  `esp_idf_nvs_partition_gen`. Other esptool versions are refused until validated.
  Outside an activated terminal, pass `--idf-path <SDK>` and `--python <SDK-Python>`.
- Run `npm ci --prefix tools --ignore-scripts` from the repository root.
- Build with ESP-IDF or extract a trusted CI firmware artifact. The installer
  consumes the existing images; it does not rebuild them.
- Verify the actual board, flash mode/frequency compatibility, stable power,
  data cable, and ROM download/recovery procedure. Close serial monitors.
  Native USB Serial/JTAG can disappear after keyboard firmware starts; recovery
  must not depend on the running application retaining a COM port.
- Read and independently confirm the factory base MAC, not an AP-interface MAC.
  `python -m esptool --chip esp32s3 --port <COMx> read-mac` is a separate
  identification command: it connects and may reset the board, but does not
  write flash. Use twelve hexadecimal digits without separators for `--device-id`.
- Decide whether existing NVS settings and ownership must be preserved. This
  command initializes NVS; it does not merge records or migrate partition tables.

The current layout is a single factory application and a writable default `nvs`
partition. The installer derives offsets and sizes from the supplied partition
table, not hardcoded write addresses. It accepts a completely blank flash or an
existing partition table that exactly matches the supplied table. It refuses
OTA layouts, encrypted partitions, secure boot, flash encryption, secure download
mode, bootloaders configured for security provisioning or anti-rollback eFuse
updates, unknown flash capacity, and unsupported configurations without overrides.
Supported detected capacities are 1/2/4/8/16/32 MiB and must fit the build.
Detecting capacity does not prove mode/frequency compatibility or USB recovery.

## Offline Check

From the repository root:

```bash
node tools/install-device.mjs --firmware build
```

The default operation validates metadata, paths, image checksums/SHA-256 digests,
partition-table integrity, partition bounds, the NVS location, and supported
build-security settings. Local builds use `config/sdkconfig.json`; downloaded
artifacts use their image-hash-bound manifest. It displays
the write layout but does not generate credentials, connect to a serial port,
write flash, or change eFuses. `--help` works without an SDK environment.

The generated ESP-IDF v6.1 JSON uses unprefixed keys such as `IDF_TARGET` and
`SECURE_BOOT`, unlike the `CONFIG_` names in the raw sdkconfig file. The installer
validates the generated JSON schema, not the raw configuration text.

For a local build you intend to transfer to another sender machine, add
`--write-manifest` to the offline command, then include `firmware-manifest.json`
alongside the three images and their flash metadata. This flag is incompatible
with `--execute`. Only the necessary security flags and image hashes are emitted,
not the full build configuration, paths, or private credentials. A trusted build
and manifest are prerequisites; these checks do not attest arbitrary binaries.

## One Initial Installation Command

Only after completing the prerequisites, substitute your verified values:

```text
node tools/install-device.mjs --firmware build --device-id <12-hex-factory-base-MAC> --output <new-private-directory-outside-repo> --port <COMx> --execute
```

`npm --prefix tools run install:device -- <options>` invokes the same command.
The output directory must not already exist. Windows ACLs or POSIX private
permissions restrict access. Serial baud defaults to 460800; `--baud 115200`
is available for a slower connection.

One invocation performs these steps:

1. Validate firmware offline; create independent random AP/setup credentials,
  a setup card, and a private firmware snapshot whose hashes are checked again
  before writing.
2. Validate the MAC-bound identity CSV and use Espressif's NVS generator to
   create an image exactly the size of the default NVS partition.
3. Open only the supplied port, confirm ESP32-S3, security state, and expected
   factory MAC, then detect physical flash capacity.
4. Read the complete detected flash, verify its digest against the device,
   save it privately, and verify the saved backup before any flash write.
5. Refuse differing existing partition tables and refuse non-empty NVS unless
   the sender explicitly requested replacement.
6. Write bootloader, partition table, NVS identity, and application in one
   esptool operation. Verify all four images, save the verification result,
  and reset into the application only after verification succeeds.

**`--replace-nvs` deliberately discards all existing default-NVS settings and
ownership, not just `kb_identity`.** Use it only for a reviewed initial-install
or recommissioning operation, not as a retry shortcut. The backup is retained,
but no old keys are merged into the new partition. The flag cannot bypass
security, identity, capacity, backup, or partition-layout checks. No whole-chip
erase, security-force option, or eFuse change is performed.

The private output contains:

```text
firmware/                 Three images, firmware-only flash metadata, and manifest
identity.csv              Private NVS input, bound to the expected factory MAC
identity.bin              Generated NVS image
wifi-qr.png               Private Wi-Fi connection QR
setup-card.html           Wi-Fi password and separate one-time owner setup code
install-plan.json         Intended offsets, sizes, hashes, and replacement policy
flash-backup.bin          Complete original flash, when backup succeeds
flash-backup.json         Backup device ID, size, offset, and SHA-256
install-result.json       Created only after all written images verify
```

For file-only CSV/QR/card generation, `tools/provision-device.mjs` remains
available. Its output is not automatically imported by the combined installer;
do not mix cards or credentials from separate generation runs.

## Failures, Updates, And Acceptance

Installation is one command, not an atomic flash transaction. Power loss or a
write error can leave partially replaced firmware or NVS. There is no automatic
retry, erase, restore, or credential regeneration. Keep the entire private output
directory, use the verified ROM recovery procedure, and review the saved plan
and backup before a separately authorized recovery write. Do not delete a
successful backup or start a fresh credential set to recover a partial install.
A failed preflight can leave private preparation files but never writes flash.

For ordinary updates with an unchanged compatible partition layout, flash only
firmware and preserve the existing NVS. `idf.py -p <COMx> flash` in the project
uses the firmware-only generated metadata; it does not install an identity.
Do not rerun initial provisioning, use `--replace-nvs`, or use an old merged BIN
as a routine update. Changed layouts require a separately reviewed migration.

After successful installation, verify that the intended board boots, its private
AP/card works, ownership can be claimed once, and AP identity plus the owner
record survive reboot. Then run the remaining Wi-Fi/USB/recovery acceptance
matrix in [the Wi-Fi plan](wifi-enhancement-plan.md#remaining-device-gates).
HTTP/WS remains a development protocol for protected, trusted test networks;
application credentials and keystrokes are not protected from network interception.

## Verification

Run these commands from an ESP-IDF terminal; none uses hardware:

```bash
node --test tools/provision-device.test.mjs
python tools/install_device_test.py
node tools/install-device.mjs --firmware build
```

The Node suite checks credential preparation, input rejection, explicit CLI
consent, offline behavior, security/manifest validation, and private snapshot isolation. The Python suite uses
the real SDK parsers/NVS generator with a fake device for security/MAC/capacity
refusals, backup ordering and integrity, layout/NVS guards, sparse writes, and
verification failure. Contract tests also call the real esptool `read_flash`,
`write_flash`, and `verify_flash` functions with only the hardware access mocked:
reads without an output path return bytes, and writes/verification accept byte
payloads. All 26 Python tests pass with both validated esptool versions. The
existing build passed offline validation with 5.3.1 as well. CI runs the SDK
suite and the freshly built firmware's offline check in the
firmware job; Node tests run with the existing browser/provisioning job.

These checks passed locally on 2026-09-15 against the existing build. They do
not establish that the combined installer has run on a physical board. No real
device identity, serial connection, flash write, erase, or eFuse change was made
while implementing it. Physical installation and recovery remain unverified.