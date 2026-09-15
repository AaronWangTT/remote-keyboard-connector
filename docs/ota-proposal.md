# OTA Update Proposal

Date: 2026-09-15
Status: draft for discussion; not implemented or approved for device installation.

This change adds only this proposal. It does not change firmware, packaging,
CI, configuration, or other documentation, and does not authorize a device
write, production signing, or release publication. The existing
[product design](remote-keyboard-design.md) excludes OTA from its original
scope; this document proposes a separate increment.

## Goal And Scope

Let an authenticated owner update the keyboard firmware and its embedded web UI
from a browser, without a serial driver, ESP-IDF, or Internet access on the
keyboard. Start with a local file upload over standalone AP or station Wi-Fi.

The proposed first increment includes:

- Signed application-only uploads, bounded streaming, and explicit activation.
- Two application slots, boot validation, and automatic rollback on failed boot.
- Preservation of device identity, owner credentials, and saved network settings.
- Separate initial-install and OTA artifacts, with offline compatibility checks.
- A guarded, one-time wired migration for existing factory-only devices.

Defer automatic Internet update checks/downloads, fleet management, delta or
compressed updates, resumable uploads, separate web-asset updates, bootloader or
partition-table OTA, PSRAM enablement, and hardware security provisioning.
ROM download recovery remains necessary; A/B OTA does not replace it.

## Baseline And Prerequisites

The proposal branch starts from `origin/main`, not the feature branches below.
Its implementation assumes the independently reviewed Wi-Fi/authentication
increment ([PR #3](https://github.com/AaronWangTT/remote-keyboard-connector/pull/3))
and guarded sender-packaging increment
([PR #4](https://github.com/AaronWangTT/remote-keyboard-connector/pull/4)).
Those changes are dependencies, not part of this proposal's diff. Reconcile
their final merged contracts before implementation.

The following observations came from the local packaging build and the hardware
identification session, not necessarily the firmware currently on `main`:

| Item | Evidence and implication |
| --- | --- |
| Physical flash | esptool 5.4.0 reported `16MB` on 2026-09-15: 16,777,216 bytes, or 16 MiB. This is chip-ID detection, not a full-range write/read test. |
| PSRAM | The chip information reported 8 MB embedded PSRAM. Initialization, interface settings, and memory tests remain unverified; OTA must not require it. |
| Current build | Configured for 2 MiB flash and one 1 MiB factory application; the observed application was 993,408 bytes. |
| Persistence | Default NVS starts at `0x9000`, size `0x6000`; preserve both its location and contents during migration. |
| Update support | No OTA slots, OTA metadata, or enabled bootloader rollback in the observed build. |
| Packaging | Current validators accept an unsigned three-image factory bundle and intentionally reject OTA layouts and signed-app profiles. |
| Hardware acceptance | Identification succeeded, but the exact board model, full-capacity operation, power behavior, and complete recovery/OTA tests are still gates. |

Do not infer physical capacity from a build setting, nor flash capacity from
PSRAM capacity. The proposed partition layout must be tested on the actual
board before shipping an OTA-capable baseline.

## Proposed Flash Layout

Use a committed custom partition table and a 16 MiB flash build profile. Keep
the existing bootloader start at `0x0` and partition table at `0x8000`. The draft
partition CSV is:

```csv
# Name,Type,SubType,Offset,Size,Flags
nvs,data,nvs,0x9000,0x6000,
phy_init,data,phy,0xf000,0x1000,
ota_0,app,ota_0,0x10000,0x400000,
ota_1,app,ota_1,0x410000,0x400000,
otadata,data,ota,0x810000,0x2000,
```

Both application slots are 4 MiB. The range `0x812000` through `0xffffff`
remains unallocated, not an additional recovery image or filesystem. OTA
metadata lives after the application slots so NVS does not need to shrink or
move. There is no separate factory application; initial installation boots
`ota_0`, and subsequent updates alternate slots.

Require the final signed and padded image to fit both slots with at least 20%
free space. Check bootloader size against the space before `0x8000`; if it no
longer fits, stop and revise the layout instead of moving into NVS implicitly.
The metadata address exceeds 8 MiB, so high-address operation is a specific
hardware gate. Four-MiB slots and the layout identifier remain review choices,
not configuration changes made by this proposal.

Keep web assets embedded in the application so UI and device protocol versions
change together. Do not introduce writable asset storage or enable PSRAM just
to buffer an update. Commit eventual defaults and the partition CSV so a clean
CI build reproduces the layout without the ignored local configuration.

## Artifact Contract

Publish two clearly distinguished firmware deliverables:

| Artifact | Contents and permitted use |
| --- | --- |
| Wired bootstrap/install bundle | OTA-capable bootloader, partition table, signed application for `ota_0`, explicit OTA-data initialization, flash metadata, and a versioned install manifest. A separate local provisioning operation supplies private NVS only for initial ownership setup. |
| Routine OTA release | One signed ESP-IDF application `.bin`, plus a public release manifest for distribution and offline inspection. The browser uploads only the binary; the device selects the inactive slot. |

The OTA artifact must not contain bootloader, partition-table, OTA-data, NVS,
credentials, backup images, or instructions choosing flash addresses. Reject
merged BINs, installation ZIPs, and multipart image bundles at the OTA endpoint.
Do not accept a file merely because it has a `.bin` extension.

The release manifest needs its own schema version and artifact kind, distinct
from the firmware release version. Record at least:

- Firmware version, exact source commit, and ESP-IDF version.
- Product/hardware profile, ESP32-S3 target and supported silicon revisions.
- Required layout identifier, minimum bootstrap version, updater protocol
  version, and compatible settings-schema versions.
- Final image byte length, SHA-256, signing-key identifier, and security profile.

Populate version information during the build; a release filename or manifest
must not disagree with the application descriptor. Embed compatibility fields
not supplied by ESP-IDF in a versioned descriptor inside the signed application.
The device must enforce those signed values and its actual slot limits, not
trust a filename, browser validation, or editable JSON sidecar. Early header
checks may reject a candidate, but its metadata is not trusted until the full
signature is verified.

Compute hashes and size limits after signing and padding. Keep the existing
factory-only manifest contract identifiable; introduce an explicit new schema
or profile for OTA rather than interpreting existing artifacts differently.
Unknown profiles and schemas fail closed. A raw chip match alone does not prove
board, flash-mode, storage-schema, or bootloader compatibility.

## Signing And Security

Propose ESP-IDF's signed-app verification without hardware Secure Boot for the
first increment, using `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` and
`CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`. Require signatures for every
accepted OTA image; do not provide an unsigned-upload bypass in the release
profile. Bootstrap installation must contain a signed initial application too.

In this ESP32-S3 mode, the trusted public key comes from the first signature
block of the installed application. Verification of the new candidate must use
that established trust, not simply a key supplied by the candidate. Keep the
private signing key outside Git, public artifacts, the device, and ordinary PR
jobs. Plan its backup and custody before distributing the first signed baseline.
Multi-key rotation is not assumed to work by appending signature blocks in this
mode; loss, compromise, or rotation needs a separately reviewed recovery plan.

Leave hardware Secure Boot, flash/NVS encryption, and eFuse anti-rollback out of
this increment. They have provisioning and recovery consequences and require
separate approval. Automatic fallback to a previous healthy application is
different from irreversible security-version anti-rollback.

Keep owner sessions, exact Host/Origin checks, CSRF protection for mutations,
bounded requests, and rate limits. The current HTTP development profile remains
restricted to protected, trusted test networks. Signatures authenticate firmware
bytes; they do not protect HTTP passwords/sessions, prevent denial of service,
or resist an attacker with arbitrary physical flash-write access. HTTPS/WSS
remains an operational-security follow-up, not solved by this package format.

For standard releases, propose numeric `major.minor.patch` ordering and reject
same-version or older uploads. Keep development images under a separate test
trust profile. This admission rule must not block automatic rollback to the
previous healthy slot. Downgrade overrides are outside the first increment.

## Local Update Flow

Expose Firmware settings with the running version, selected candidate version,
upload progress, verification result, activation confirmation, and final boot
outcome. Do not report success just because all bytes left the browser.

Proposed routes follow the existing versioned management API:

| Route | Behavior |
| --- | --- |
| `POST /api/v1/update` | Receive a raw `application/octet-stream` body with a known length; reserve one update job and stream it to the inactive slot. |
| `GET /api/v1/update/job` | Return bounded progress, job ID, candidate identity, and result to an authenticated owner. |
| `DELETE /api/v1/update/job` | Cancel before activation and release job resources; leave the running app selected. |
| `POST /api/v1/update/activate` | Confirm the verified job ID and candidate digest, select it for boot, and schedule restart. |

Extend authenticated status with the running version, bootstrap/layout profile,
and OTA validation state. Route names are proposed, not new supported APIs.

1. Require the owner to release keyboard control before admission. Atomically
   reject active or pending control, a network transition, or another update.
2. Reserve update mode across both interfaces. Prevent new control acquisition,
   Wi-Fi reconfiguration, and automatic AP shutdown for the job's bounded
   lifetime. An initial management touch alone is not a sufficient network hold.
3. Clear queued/held input and invalidate leases. When USB is ready, confirm
   the all-keys-up report before flash work; abort if that cannot complete within
   a bounded deadline. An absent USB host must not prevent maintenance.
4. Validate type, length, preliminary headers, and compatibility limits. Stream
   into the inactive slot through `esp_ota_begin()` and `esp_ota_write()` with a
   small fixed internal-RAM buffer. Never hold the whole image in RAM.
5. Use bounded asynchronous HTTP request ownership and an update worker so
   flash operations do not monopolize the HTTP server. Keep status and
   cancellation responsive; serialize state changes and use finite receive,
   inactivity, total-job, and staged-image deadlines.
6. On complete receipt, call `esp_ota_end()` and enforce signature plus signed
   compatibility checks. Only a fully verified image becomes staged. Truncation,
   cancellation, timeout, invalid metadata, or failure must never select it.
7. Wait for explicit activation. Recheck session/CSRF, job identity, and staged
   validity; only then call `esp_ota_set_boot_partition()`. A stale tab must not
   activate a different candidate. Keep input disabled through restart.
8. Complete the activation response before a scheduled reboot, with a bounded
   fallback if the connection disappears. Once boot selection succeeds, do not
   promise that canceling the browser can cancel activation.
9. Reconnect at the existing hostname/IP, refresh embedded assets, and verify
   the actually running version. Reboot revokes sessions; require login and
   fresh explicit Take Control. Never replay held keys.

An interrupted transfer restarts from byte zero on explicit retry. A staged
candidate expires without changing boot selection. A lost response is an unknown
result until status is checked, not a reason to blindly repeat activation.

## Boot Validation And Rollback

Enable `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` in the wired baseline. On a boot
marked `ESP_OTA_IMG_PENDING_VERIFY`, run bounded diagnostics before calling
`esp_ota_mark_app_valid_cancel_rollback()`:

- Read and validate existing identity and settings without destructive migration.
- Initialize the USB service with input released and verify service-task health.
- Establish a usable station interface or protected recovery AP and a functioning
  web-management service.
- Check critical allocation/startup failures and liveness during the trial boot.

Do not require Internet, NTP, a browser reconnect, or USB host enumeration to
accept the image. A powered-off router should permit protected-AP recovery, not
automatically condemn the update. Choose the diagnostic deadline to include
bounded station retry/recovery, and confirm promptly after checks pass.

On failure, use `esp_ota_mark_app_invalid_rollback_and_reboot()`. A watchdog or
explicit timeout must force recovery from a hung trial; the bootloader cannot
roll back an application that never resets. Reset or power loss during an
unconfirmed trial triggers fallback on the next boot. These checks do not prove
every keyboard behavior correct; post-update USB/browser acceptance remains
necessary.

Do not erase the previous healthy image after confirmation. It is reused only
as the inactive target of a later update. Ensure the initial wired `ota_0` is a
usable fallback before admitting the first OTA, and test that first rollback
specifically, not only later A/B cycles. Never allow another update while the
running image remains pending verification.

Rollback switches applications, not NVS. Version 1 must preserve the existing
settings schemas. Future migrations must remain readable by the retained
fallback, including after the new app is confirmed; deferring a destructive
schema change until confirmation alone is insufficient.

## Initial Installation And Migration

Packaging cannot retrofit OTA into the current running factory-only firmware.
Existing boards need a separately authorized wired bootstrap operation. New
boards can receive the OTA-capable baseline during initial sender installation.

Extend installer support using an explicit validated OTA profile, not by
removing the current single-app/security guards. Parse generated metadata and
the partition table, allow only known image roles, initialize OTA data
deterministically, and account for its bytes in every bounds/write/verify check.
Do not assume a three-image flash manifest once OTA initialization is added.

For migration of an already provisioned board:

1. Confirm expected factory MAC, chip, detected capacity, security state, source
   layout, flash settings, stable power, and a usable ROM recovery path.
2. Save and independently verify a complete private flash backup before any
   write. Treat backups as credential-bearing artifacts outside the repository.
3. Verify trusted destination binaries, signatures, layout, bootstrap version,
   and NVS-preservation ranges. Refuse unknown source layouts or overlapping
   writes; do not make `--replace-nvs` a migration shortcut.
4. Write only the reviewed bootstrap/partition/application/OTA-data ranges,
   using sparse writes with sector-erase boundaries accounted for. Do not write
   a merged image, regenerate ownership, erase the whole chip, or burn eFuses.
5. Verify all changed ranges and the preserved NVS bytes before normal boot.
   Confirm owner login, private AP identity, saved network behavior, USB typing,
   and rollback readiness afterward.

The wired migration is not an atomic or power-failure-safe transaction. Record
the write plan and recovery procedure; interrupted writes require reviewed
recovery from the retained backup, not automatic retries or reprovisioning.
Keep blank-device provisioning and existing-owner migration separate operations.

## Packaging And CI Work

The [current CI workflow](../.github/workflows/ci.yml) remains unchanged by this
proposal. Future implementation should:

- Build the committed OTA profile from a clean checkout and validate the exact
  final signed image against both slots, headroom, and compatibility metadata.
- Reuse the existing Node/SDK installer validation patterns, with tests for new
  roles, malformed tables, signed images, private snapshots, and preserved NVS.
  Use the ESP-IDF parsers and signature tools instead of custom cryptography.
- Keep ordinary PR artifacts explicitly test-only. Exercise signing and
  verification with test-only keys that production devices do not trust.
- Add a separate controlled release path for a reviewed main revision. Restrict
  production signing to a protected signing environment or external signer;
  never execute untrusted PR code with release-key access.
- Publish versioned, durable release downloads instead of relying on the current
  14-day CI artifact retention. Bind the release to its exact source revision
  and signed bytes; do not rebuild or modify the image after calculating hashes.
- Preserve the existing required check names and run them on the eventual PR.
  Publishing permissions belong only to the release path. No CI hardware writes,
  credential generation for real devices, or eFuse operations are introduced.

Keep flash/update state in a focused firmware component, with thin HTTP handlers;
coordinate maintenance gating with network and USB ownership. Let startup own
trial-boot diagnostics. Extend the existing preview and tests only when the
implementation is separately approved; this proposal creates no components.

## Acceptance Gates

All OTA gates below are pending. Host tests and a successful build are not
substitutes for the device checks.

| Gate | Required evidence |
| --- | --- |
| Artifact isolation | OTA output contains only the signed app and public metadata; no install images, NVS, secrets, or address-selection instructions. |
| Compatibility and bounds | Reject malformed, oversized, truncated, wrong-chip/product/layout/bootstrap/schema images and disallowed versions. Check final signed size against both slots. |
| Authenticity | Reject unsigned, corrupted, wrong-key, and altered signed-descriptor images even if the unsigned manifest is changed to match. |
| Admission and concurrency | Reject active/pending keyboard control, concurrent uploads and network jobs; AP hold, expiry, cancellation, and status remain bounded and race-free. |
| Interrupted update | Power or network loss during erase/write/verification leaves the running image bootable and input disarmed; no partial image is selected. |
| Trial boot | Exercise power loss around boot selection and trial boot, deliberate startup failure/hang, first-update rollback, later A/B cycles, and successful confirmation. |
| Persistent settings | Identity, ownership, and saved Wi-Fi survive migration, update, and fallback; neither credentials nor incompatible schemas are silently replaced. |
| Real keyboard behavior | AP/STA browser flows, host absent/suspended, all-keys-up before update, reconnect/login, and explicit reacquisition work on actual USB hardware. |
| Resource budget | Measure free internal heap, stack high-water marks, HTTP responsiveness, watchdog behavior, power stability, and signed-image headroom under update load. |
| Full-capacity and recovery | Validate the proposed high flash addresses and wired recovery on the identified board before accepting a 16 MiB production profile. |

## Rollout And Open Decisions

1. Review this standalone proposal; settle the hardware/layout profile, signing
   custody, release/version policy, and diagnostic deadlines.
2. After the Wi-Fi and packaging prerequisites are integrated, implement the
   OTA build/artifact contracts and narrow validator tests in a separate change.
3. Add device update handling, boot diagnostics, and browser/preview coverage.
4. Implement and review wired bootstrap/migration, then execute the hardware
   gates only with explicit device-write approval and verified backups.
5. Enable controlled release signing/publication after acceptance; leave online
   discovery and hardware security provisioning for later proposals.

Open decisions include the exact board/profile identity, whether 4 MiB slots
are the desired long-term allocation, the signing key's custodian and recovery
policy, numeric release-version rules, upload/trial-boot timeout budgets, and
the approved release distribution location. Values and flows above are proposed
defaults, not authorization to change the board or existing workflows.

## References

- [ESP-IDF v6.1 OTA and rollback](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/ota.html)
- [ESP-IDF v6.1 partition tables](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/partition-tables.html)
- [Signed apps without hardware Secure Boot](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/security/secure-boot-v2.html#signed-app-verification-without-hardware-secure-boot)