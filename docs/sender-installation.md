# Sender Installation And Firmware Artifacts

The sender installs and tests each ESP32-S3 before shipping. Recipients only
need the private setup card and a browser. Installation is a separate, explicit
device operation, never part of a firmware build or CI upload.

## Public Firmware And Private Installation Files

Every normal build produces `firmware-install.zip` for wired fresh installation
and `firmware-ota.bin` for browser OTA. They contain identical signed application
bytes, with public manifests and SHA-256 sidecars. The wired ZIP contains the
bootloader, new partition table, OTA-data initializer, application, generated
flash metadata, and signed version-3 install manifest. It contains no private
key, credentials, or NVS image. Extract the ZIP to a directory for `--firmware`.
The installer still requires a matching trusted checkout and the SDK below.

Default builds use an ignored local RSA-3072 test key and are labeled test-only.
The key is reused across local builds so a development device can accept later
updates. CI generates its own ephemeral test key, not a release key. A public
key delivered alongside a candidate is useful for offline testing but is not
independent evidence that the candidate is trustworthy. Never fabricate or edit
a manifest to bypass validation.

The sender command creates a different, private per-device directory outside
the repository. It includes a firmware snapshot, identity CSV/BIN, Wi-Fi QR,
printable setup card, and install plan with SHA-256 hashes.
These files contain credentials or device data. Never upload them to Git,
Actions artifacts, issue attachments, or shared logs. Optional old-flash backups
are also private. They are not inputs to fresh installation or a required feature.

Merged images are deliberately excluded from OTA. A wired replacement explicitly
erases flash and provisions fresh NVS; routine OTA writes only the inactive app
slot and preserves identity, ownership, and Wi-Fi settings.

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
- Explicitly accept a full layout reset for wired replacement. It discards all
  old ownership, AP credentials, saved Wi-Fi, and calibration records. Use OTA
  instead when updating a device already installed on the new layout.
- Obtain the trusted RSA-3072 public verification key independently of the
  candidate bundle. The installer accepts only public PEM input and, for writes,
  requires its path outside the firmware directory. A private key is never sent
  to the device or through the installer helper.

The target is exactly the committed 16 MiB layout: 64 KiB NVS, 8 KiB OTA metadata,
and two 6 MiB app slots. It is validated independently against generated metadata.
The board must report 16 MiB flash and support the DIO/80 MHz profile. The signed
image's headers are retained using esptool's `flash_size=keep`, not rewritten.
Hardware Secure Boot, flash encryption, security-force overrides, and eFuse
anti-rollback are not part of this profile. Detecting capacity alone does not
prove full-range operation or USB recovery.

The build must enable `KEYBOARD_HTTP_DEVELOPMENT`; otherwise the web server,
setup card URL, and owner-claim flow are unavailable. Build validation requires
the generated setting to be `true`. Signed install manifests bind
`security.httpDevelopment: true` to the image hashes, and the Python helper
independently enforces that contract. This explicit development-protocol setting
does not add transport encryption or establish production security.

## Offline Check

From the repository root:

```bash
node tools/install-device.mjs --firmware build --verification-key /trusted/keyboard-public.pem
```

The default operation validates metadata, paths, image checksums/SHA-256 digests,
partition-table integrity, partition bounds, the NVS location, and supported
build-security settings. New normal-build artifacts require the authenticated
install manifest and application signature, verified with the supplied key. It displays
the write layout but does not generate credentials, connect to a serial port,
write flash, or change eFuses. `--help` works without an SDK environment.

The generated ESP-IDF v6.1 JSON uses unprefixed keys such as `IDF_TARGET` and
`SECURE_BOOT`, unlike the `CONFIG_` names in the raw sdkconfig file. The installer
validates the generated JSON schema, not the raw configuration text.

For a default local test build only, offline checks may use the generated
`build/firmware-signing-public.pem`. For an actual installation, export or obtain
the expected public key through your trusted build/signing process and retain it
outside the candidate directory. The build now generates the signed manifests
automatically; `--write-manifest` is not needed for normal OTA-capable outputs.

## One Initial Installation Command

Only after completing the prerequisites, substitute your verified values:

```text
node tools/install-device.mjs --firmware build --verification-key <trusted-public-PEM-outside-bundle> --device-id <12-hex-factory-base-MAC> --output <new-private-directory-outside-repo> --port <COMx> --execute --reset-layout
```

`npm --prefix tools run install:device -- <options>` invokes the same command.
The output directory must not already exist. Windows ACLs or POSIX private
permissions restrict access. The Python helper independently creates a new
`installation` subdirectory and restricts its permissions before writing private
data, including when invoked directly. Its JSON request carries the MAC-bound
identity CSV over stdin; an existing output directory is never accepted. Windows
account or ACL failures stop preparation before a serial connection.
Serial baud defaults to 460800; `--baud 115200` is available for a slower connection.

For an intentionally installed test-key build, also add `--allow-test-firmware`.
This is not an unsigned-upload bypass: later OTA still requires the same trusted
application key. One invocation performs these steps:

1. Validate firmware offline; create independent random AP/setup credentials,
  a setup card, and a private firmware snapshot whose hashes are checked again
  before writing. Synchronize every credential, card, and snapshot file before
  invoking the installation helper; on POSIX, also synchronize each containing
  directory. Failure stops before a serial connection and retains the private files.
2. Validate the MAC-bound identity CSV and use Espressif's NVS generator to
   create an image exactly the size of the default NVS partition. Synchronize
   that file and, on POSIX, its directory before connecting to the board.
3. Open only the supplied port, confirm ESP32-S3, security state, and expected
   factory MAC, then detect physical flash capacity.
4. After those checks, perform the explicitly approved full erase. Do not read,
  interpret, or convert the previous partition table or NVS.
5. Write bootloader, partition table, initialized OTA metadata, NVS identity,
  and signed application using the validated target offsets.
6. Verify all written ranges, re-read the application and verify its signature,
  save the result, and reset only after verification succeeds. Complete fresh
  owner claim and Wi-Fi setup after boot.

**`--reset-layout` deliberately discards the whole previous installation.**
It is distinct from the legacy `--replace-nvs` flag, which cannot authorize this
layout. There is no dedicated migration tool, source-layout conversion, or old
credential import. No eFuses are changed.

The private output contains:

```text
firmware/                       Four public images, flash metadata, signed manifest
identity.csv                    Private input, bound to the factory MAC
wifi-qr.png                     Private Wi-Fi connection QR
setup-card.html                 Wi-Fi password and one-time owner setup code
installation/identity.csv       Validated private NVS input copy
installation/identity.bin       Generated NVS image
installation/install-plan.json  Offsets, sizes, hashes, and replacement policy
installation/install-result.json  Created only after all written images verify
```

For file-only CSV/QR/card generation, `tools/provision-device.mjs` remains
available. Its output is not automatically imported by the combined installer;
do not mix cards or credentials from separate generation runs.

## Failures, Updates, And Acceptance

Installation is one command, not an atomic flash transaction. Power loss or a
write error can leave partially replaced firmware or NVS. There is no automatic
retry, erase, restore, or credential regeneration. Keep the entire private output
directory, use the verified ROM recovery procedure, and review the saved plan
before a separately authorized recovery write. Do not start a fresh credential
set to recover a partial install; retain the already prepared images and card.
A failed preflight can leave private preparation files but never writes flash.
After all flash images verify, a failure saving the result record is still
reported as an error, but the installer attempts to reset the verified board
into its application. Failed flash verification never triggers that reset.

Private-file verification is not an unconditional host power-loss guarantee.
On POSIX, private file contents and their directory entries are synchronized with
`fsync`; the new directory's ancestor entries are also synchronized. A failed
synchronization stops installation before any flash write. This relies on the
filesystem and storage device honoring those requests.
On Windows, file contents are synchronized, but directory-entry durability is not
guaranteed. Keep the host and private artifact storage powered; a host or storage
failure can still lose files needed for recovery. Windows filesystem acceptance
remains a hardware/environment gate, not something Linux mocks can prove.

For ordinary updates, connect through either standalone AP or the device's
station/LAN address, sign in, release control, and open Network > Firmware
updates. Upload `firmware-ota.bin`, wait for verification, then select Install
and restart. Sign in again and check the running version. An upload alone does
not activate an image; a lost response is resolved through status, not by
automatically repeating activation. Wi-Fi settings and ownership survive OTA
and rollback. Do not use an install ZIP or a merged BIN as an OTA image.

The default version is `0.1.0`. A subsequent build needs a higher numeric version,
for example `idf.py -D PROJECT_VER=0.1.1 build`, with the same board/layout and
signing key. Same-version and older OTA uploads are rejected. Full wired
replacement remains available for each normal build, with reset/reprovisioning.

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
node tools/install-device.mjs --firmware build --verification-key build/firmware-signing-public.pem
```

The Node suite checks credential preparation, input rejection, explicit CLI
consent, offline behavior, security/manifest validation, and private snapshot isolation. The Python suite uses
the real SDK parsers/NVS generator with a fake device for security/MAC/capacity
refusals, backup ordering and integrity, sector-rounded application bounds,
HTTP owner-claim prerequisites, layout/NVS guards, sparse writes, and
verification failure. Contract tests also call the real esptool `read_flash`,
`write_flash`, and `verify_flash` functions with only the hardware access mocked:
reads without an output path return bytes, and writes/verification accept byte
payloads. The original 26-test Python suite passed with both validated esptool
versions. The existing build passed offline validation with 5.3.1 as well.
The suite now also checks fresh private-directory creation, existing-directory
and symlink rejection, ACL failures, directory-sync failures, and explicit Windows
durability reporting. Windows ACL subprocesses are mocked in Linux testing; these
tests do not establish Windows filesystem acceptance. CI runs the SDK suite and
the freshly built firmware's offline check in the firmware job; Node tests run
with the existing browser/provisioning job.

The OTA additions exercise real RSA image and manifest verification, identical
wired/OTA outputs, legacy-cost rejection, explicit reset/test-key consent,
unknown old layouts, wrong-device/capacity refusals, and failed readback without
resetting. Native tests cover inactive-slot writes, cancellation, expiry,
activation, and trial-boot handling. Browser tests cover AP and station flows.
These do not establish physical installation, full-capacity operation, power-loss
behavior, or recovery. No real device was flashed during implementation.

## Trusted Release Builds

Keep the release private key and a backup outside Git. A private configuration
overlay outside the repository sets `CONFIG_KEYBOARD_RELEASE=y` and
`CONFIG_SECURE_BOOT_SIGNING_KEY="/private/keyboard-release.pem"`. Build from a
clean reviewed commit with a fresh configuration directory and that overlay
after the committed defaults. The key must be RSA-3072 and outside the checkout.
The descriptor labels the result as a release; builds with missing verification
settings, wrong image sizes, or inconsistent metadata fail packaging.

Normal CI has no release key and cannot produce trusted releases. Signing a
release locally still produces both artifacts from exactly one signed app.
After device acceptance and separate publication approval, distribute both
artifacts and public metadata through a durable GitHub Release. Key provisioning,
publication, and recovery from key loss/compromise remain explicit operator steps.