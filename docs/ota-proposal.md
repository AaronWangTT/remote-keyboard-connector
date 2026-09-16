# OTA Update Proposal

Date: 2026-09-15
Updated: 2026-09-16
Status: software implemented on `feature/local-ota`; physical acceptance and trusted-release setup pending.

Implementation was authorized on 2026-09-16. This document records the agreed
design and the software implementation below. It does not authorize a device
write, production-key provisioning, or release publication. OTA extends the
original [product design](remote-keyboard-design.md) as a separate increment.

## Goal And Scope

Let an authenticated owner update the keyboard firmware and its embedded web UI
from a browser, without a serial driver, ESP-IDF, or Internet access on the
keyboard. Start with a local file upload over standalone AP or station Wi-Fi.

The immediate target is a personal device on a protected, trusted local network.
Prioritize responsive login and a simple initial installation. This is not a
hardened public-service profile.

Two requirements define this plan:

1. **Start from a fresh installation with a full layout reset.** Erase an existing
   board, flash the new layout, and provision it as a new device. Use the normal
   flash/provisioning workflow; no dedicated migration tools, old-layout
   conversion, or old-credential preservation are required.
2. **The normal build supports both wired flash replacement and OTA update.**
   Produce both deliverables from the same signed application, using the same
   board configuration and source revision. Do not introduce separate factory-only
   and OTA-only firmware builds.

The proposed first increment includes:

- Signed application-only uploads, bounded streaming, and explicit activation.
- Two application slots, boot validation, and automatic rollback on failed boot.
- Preservation of device identity, owner credentials, and saved network settings
   during routine OTA and rollback, not during the one-time clean installation.
- Wired replacement and OTA artifacts from every normal build, with offline
   compatibility checks.
- Normal fresh installation and provisioning after an explicitly approved reset.
- A lower password-derivation cost for the personal-use profile.

Defer automatic Internet update checks/downloads, fleet management, delta or
compressed updates, resumable uploads, separate web-asset updates, bootloader or
partition-table OTA, PSRAM enablement, and hardware security provisioning.
Legacy layout/credential migration and dedicated migration tooling are outside
this plan, not prerequisites for it.
ROM download recovery remains necessary; A/B OTA does not replace it.

## Discussion Decisions

The working direction from the 2026-09-16 discussion is:

| Area | Planned decision |
| --- | --- |
| Flash profile | Use the identified 16 MiB device, subject to full-capacity and recovery validation. The existing 2 MiB build setting is not the physical capacity. |
| Application capacity | Two equal 6 MiB slots, replacing the 1 MiB application limit and the earlier draft's 4 MiB slots. No third factory application. |
| NVS capacity | Increase from 24 KiB to 64 KiB; use it for small persistent settings, not web assets, logs, or crash dumps. |
| Installation baseline | Assume a fresh installation with the entire layout reset and fresh provisioning through the normal wired workflow. No previous layout, credentials, or backup is an input to installation. |
| Normal build | Produce both a wired flash-replacement/install bundle and an application-only OTA image by default for the selected board/profile. Both contain the same signed application bytes; no separate firmware build is required. |
| Login cost | Use 10 total PBKDF2-HMAC-SHA-256 iterations instead of 100,000, not a tenfold reduction. Accept the offline-password-guessing tradeoff for this personal-use profile. |
| Subsequent updates | Signed, application-only A/B updates with boot validation and rollback; keep credentials and settings. Reboot requires login again, not ownership claim again. |
| Remaining flash | Leave the tail unallocated unless a concrete storage requirement is identified before the layout is frozen. Adding a partition later still requires a new layout. |

The software implements these decisions. Device-level behavior still requires
the physical acceptance gates; simulated tests do not establish those results.

## Baseline And Prerequisites

Build on the existing Wi-Fi/authentication contracts
([PR #3](https://github.com/AaronWangTT/remote-keyboard-connector/pull/3))
and guarded sender-packaging contracts
([PR #4](https://github.com/AaronWangTT/remote-keyboard-connector/pull/4)).
Reconcile their current implementations before extending them; this proposal
does not implement or replace those prerequisites.

The following observations came from the local packaging build and the hardware
identification session, not necessarily the firmware currently on `main`:

| Item | Evidence and implication |
| --- | --- |
| Physical flash | esptool 5.4.0 reported `16MB` on 2026-09-15: 16,777,216 bytes, or 16 MiB. This is chip-ID detection, not a full-range write/read test. |
| PSRAM | The chip information reported 8 MB embedded PSRAM. Initialization, interface settings, and memory tests remain unverified; OTA must not require it. |
| Local build observation | Configured for 2 MiB flash and one 1 MiB factory application. The historical 993,408-byte unsigned image size has unverified provenance: its exact source/configuration pair was not recorded, so it is not a reproducible baseline. |
| Persistence | Default NVS starts at `0x9000`, size `0x6000` (24 KiB). The proposed clean installation replaces its contents and increases its size to 64 KiB. |
| Login derivation before OTA | The previous baseline used 100,000 PBKDF2-HMAC-SHA-256 iterations. New OTA firmware and provisioning use 10; retained legacy factory-artifact provisioning keeps its original cost rather than silently changing that old contract. |
| Update support | No OTA slots, OTA metadata, or enabled bootloader rollback in the observed build. |
| Packaging | The current factory installer accepts an unsigned, unencrypted bootloader/partition-table/app bundle and rejects changed layouts and unsupported security profiles. Adapt the existing install/provisioning validators to the new normal build and fresh-install target contract; do not add a legacy migration path or silently weaken the old artifact guards. |
| Hardware acceptance | Identification succeeded, but the exact board model, full-capacity operation, power behavior, and complete recovery/OTA tests are still gates. |

Do not infer physical capacity from a build setting, nor flash capacity from
PSRAM capacity. The proposed partition layout must be tested on the actual
board before shipping an OTA-capable baseline.

Sizes from different revisions, configurations, and signing profiles are not
interchangeable. Establish the OTA size baseline with a clean build using the
exact source commit, pinned SDK/dependencies, and committed board profile.
Record the effective configuration fingerprint and final signed/padded image
byte length and SHA-256 in the validation report; headroom uses that image,
not the historical observation.

## Proposed Flash Layout

Use a committed custom partition table and a 16 MiB flash build profile. Keep
the existing bootloader start at `0x0` and partition table at `0x8000`. The draft
partition CSV is:

```csv
# Name,Type,SubType,Offset,Size,Flags
nvs,data,nvs,0x9000,0x10000,
otadata,data,ota,0x19000,0x2000,
phy_init,data,phy,0x1b000,0x1000,
ota_0,app,ota_0,0x20000,0x600000,
ota_1,app,ota_1,0x620000,0x600000,
```

Both application slots are 6 MiB, for 12 MiB total; each firmware image must
fit one slot. NVS is 64 KiB, OTA metadata is 8 KiB, and both application starts
are 64 KiB aligned. Enlarging NVS overlaps the old application's `0x10000`
start, so this is a new layout, not an in-place NVS resize.

The 16 KiB alignment gap at `0x1c000` through `0x1ffff` and the 3.875 MiB tail
at `0xc20000` through `0xffffff` remain unallocated. They are not a filesystem
or recovery image. Decide any concrete crash-dump or other data-partition need
before freezing the table; unused flash does not let a later OTA add partitions.
There is no separate factory application. Initial installation boots `ota_0`,
and subsequent updates alternate slots.

Six-MiB slots prioritize application and embedded-UI growth without reserving
nearly half the chip for unidentified data needs. Larger slots do not require
equally large RAM buffers or uploads: transfer the actual image and supply its
validated length when beginning OTA, rather than erasing a whole slot by default.

The present application-managed identity and network records are small, so
24 KiB is not a demonstrated capacity failure. Choose 64 KiB (16 flash pages)
for settings growth and NVS garbage-collection headroom. Total on-device usage,
including SDK records and bookkeeping, has not been measured. Record
`nvs_get_stats()` after provisioning, owner claim, and repeated Wi-Fi settings
changes, together with the NVS RAM overhead. Keep bulk data outside NVS.

The committed OTA profile must specify `CONFIG_ESP_PHY_INIT_DATA_IN_PARTITION=n`
and `CONFIG_ESP_PHY_CALIBRATION_AND_DATA_STORAGE=y`. PHY initialization data is
embedded in each signed application; `phy_init` is reserved but unused. It needs
no separate image and remains erased during clean installation. RF calibration
records are different from PHY initialization data: ESP-IDF stores them in NVS
and recalibrates when they are absent after the reset. Old calibration bytes
do not need preservation. A partition-backed PHY profile needs a separately
specified artifact and installation contract; it must not silently reuse this
embedded-data profile.

Require the final signed and padded image to fit both slots with at least 20%
free space, an image budget of at most 4.8 MiB per slot. Check bootloader size
with the intended signing/rollback settings against the space before `0x8000`;
if it no longer fits, stop and revise the layout before freezing it. Do not move
into NVS implicitly. The second slot extends above 8 MiB, so high-address
operation remains a specific hardware gate. Validate the complete table against
16 MiB and assign a layout identifier before generating installable artifacts.

Keep web assets embedded in the application so UI and device protocol versions
change together. Do not introduce writable asset storage or enable PSRAM just
to buffer an update. Commit eventual defaults and the partition CSV so a clean
CI build reproduces the layout without the ignored local configuration.

## Login Cost

Use **10 PBKDF2-HMAC-SHA-256 iterations** for the new personal-use baseline,
instead of 100,000. Keep salted derivation, the existing digest length,
constant-time verification, owner sessions, and login rate limits. This is a
cost change, not replacement of PBKDF2 with ten raw SHA-256 calls. The iteration
count is 10,000 times lower; that does not imply an equal improvement in total
browser login latency.

This deliberately gives up most of the current protection against offline
password guessing if someone obtains the stored verifier. Online rate limits
do not mitigate that attack. The choice prioritizes personal-device experience;
do not present it as appropriate for hardened or Internet-exposed deployment.
HTTP transport still exposes credentials and sessions on an untrusted network,
regardless of the KDF cost. Firmware signatures remain a separate requirement.

Implement this as one coordinated credential-policy change:

- Change the [firmware KDF policy](../components/device_identity/include/device_identity.h)
   and keep [identity/owner verification](../components/device_identity/device_identity.c)
   consistent with the stored iteration fields.
- Change [provisioning](../tools/provision-device.mjs), the
   [installer's identity validation](../tools/install_device.py), the
   [preview login](../tools/preview.mjs), and their existing test fixtures together.
- Generate the fresh setup-code verifier with the new cost. Fresh owner claim
   must also write a 10-iteration owner verifier; do not reinterpret old
   100,000-iteration records or erase NVS automatically on a policy mismatch.
- Cover the credential policy in firmware compatibility checks. All images in
   this OTA baseline, including the retained fallback, must understand it.
- Test correct and incorrect credentials, rejected legacy costs, and unchanged
   authentication/rate-limit behavior. Measure derivation time and end-to-end
   login on the actual board; capture the old baseline before reset when possible.

Fresh provisioning creates the baseline's credentials; converting credentials
from an old installation is not supported or required. Later OTA and rollback
preserve the new records. Normal OTA firmware, provisioning, and preview now
use 10 iterations. The retained factory-only installer path keeps 100,000 for
old artifacts, while the new profile rejects those old records.

## Artifact Contract

The normal build workflow must produce both deliverables by default for the
selected board/profile. Build and sign the application once, then package those
exact bytes for both installation methods. No OTA-specific build switch,
alternate firmware configuration, or recompilation is needed to choose between
wired replacement and OTA. Firmware installed by either method supports later
OTA updates.

Keep the two outputs clearly distinguished:

| Artifact | Contents and permitted use |
| --- | --- |
| Wired flash-replacement/install bundle | OTA-capable bootloader, partition table, signed application for `ota_0` with embedded PHY initialization data, explicit OTA-data initialization, flash metadata, and an independently authenticated versioned install manifest covering every public image and write offset. Supports fresh installation and later full replacement/recovery over USB. No separate PHY image. Generate private 64 KiB NVS locally for each fresh installation; never publish it in this bundle. |
| Routine OTA image | The same signed ESP-IDF application `.bin`, plus a public release manifest for distribution and offline inspection. For devices already on the new layout, the browser uploads only the binary over AP or station Wi-Fi; the device selects the inactive slot and preserves NVS. |

Require byte-for-byte equality between the signed application in the wired
bundle and the OTA payload. Their version, source revision, board/layout and
credential-policy identifiers, final image length, and application SHA-256 must
agree. Test and release signing keys may differ between build workflows, but
not between the two outputs of one build.

Wired replacement remains available for every version, not only initial setup.
For this increment, full replacement means the same fresh reset/install/provision
workflow; a settings-preserving serial update path is not required. Build and
packaging alone never erase, flash, or generate real per-device credentials.
Those remain explicit installation operations. Routine OTA never resets the
layout or repeats provisioning.

The OTA artifact must not contain bootloader, partition-table, OTA-data, NVS,
credentials, backup images, or instructions choosing flash addresses. Reject
merged BINs, installation ZIPs, and multipart image bundles at the OTA endpoint.
Do not accept a file merely because it has a `.bin` extension.

The release manifest needs its own schema version and artifact kind, distinct
from the firmware release version. Record at least:

- Firmware version, exact source commit, and ESP-IDF version.
- Product/hardware profile, ESP32-S3 target and supported silicon revisions.
- Required layout identifier, minimum bootstrap version, updater protocol
   version, and compatible settings-schema and credential-policy versions.
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

Pin `CONFIG_SECURE_SIGNED_APPS_RSA_SCHEME=y` (RSA-3072) for this ESP32-S3
profile instead of relying on ESP-IDF's default signing choice. A change to
ECDSA or another scheme requires a new, separately reviewed security profile.
With the repository's minimal build, the component that owns OTA and trial-boot
operations must declare `PRIV_REQUIRES app_update`; this keeps ESP-IDF's OTA and
image-signature verification code and Kconfig in the dependency graph. Clean CI
must assert the generated signing settings and reject a missing verifier
dependency before packaging.

Authenticate the wired bootstrap as a whole before relying on its application
key. The installer must start with a release-verification public key or exact
approved digests obtained through a trusted channel outside the candidate
bundle. Use that independent trust root to verify a signed install manifest
covering the exact bootloader, partition table, `ota_0`, OTA-data initializer,
security profile, and write offsets before writing, then re-read every written
range and compare it with the authenticated manifest. A signature or digest
declared only inside the candidate bundle is not evidence of provenance.

In this ESP32-S3 mode, the trusted public key comes from the first signature
block of the installed application. Verification of the new candidate must use
that established trust, not simply a key supplied by the candidate. A bootstrap
being signed is therefore insufficient to authenticate its initial key. Before
writing any new or reset board, the wired installer must obtain the expected
production public-key fingerprint from a trusted source independent of the
candidate bundle, extract the key from the `ota_0` signature block, compare its
fingerprint, and verify the image with that pinned key. Re-read the written image
and repeat both checks before first boot; never accept a fingerprint declared
only by the bundle being verified. Record the expected and observed fingerprints
in the private installation report so the bootstrap establishes the key that later
OTA verification derives from the running application.

Keep the private signing key outside Git, public artifacts, the device, and
ordinary PR jobs. Plan its backup and custody before distributing the first
signed baseline. Multi-key rotation is not assumed to work by appending
signature blocks in this mode; loss, compromise, or rotation needs a separately
reviewed recovery plan.

Leave hardware Secure Boot, flash/NVS encryption, and eFuse anti-rollback out of
this increment. They have provisioning and recovery consequences and require
separate approval. Automatic fallback to a previous healthy application is
different from irreversible security-version anti-rollback. The authenticated
wired installation establishes the initial network-update baseline, but without
hardware Secure Boot an attacker with physical flash-write access can replace
the bootloader or application trust anchor afterward; this profile does not
claim to resist that attack.

Retain the existing owner sessions, exact Host/Origin checks, CSRF protection
for mutations, bounded requests, and rate limits. Never expose OTA without
those controls. The HTTP-only personal/development profile remains restricted
to protected, trusted local networks. The low-cost login decision above does
not remove these controls or establish production-grade password protection.
Signatures authenticate firmware bytes; they do not protect HTTP
passwords/sessions, prevent denial of service, or resist an attacker with
arbitrary physical flash-write access. HTTPS/WSS remains an
operational-security follow-up, not solved by this package format.

For standard releases, propose numeric `major.minor.patch` ordering and reject
same-version or older uploads. Keep development images under a separate test
trust profile. This admission rule must not block automatic rollback to the
previous healthy slot. Downgrade overrides are outside the first increment.

## Local Update Flow

Serve a separate Firmware Update page at `http://kb.local/ota`, also reachable
via `/ota` on the device's current AP or station hostname/IP. Users enter this
URL directly. Remove the keyboard/network settings Firmware button and do not
add links or navigation between the two pages. Use separate HTML/controllers;
the keyboard page must not load the OTA controller or poll OTA endpoints.

The OTA page accepts the existing owner session or presents its own sign-in
form. Login, logout, reconnect, and reboot confirmation remain on `/ota`, with
no redirect to the keyboard page. This is UI separation, not an authentication
boundary: every update operation still requires the existing owner and CSRF
checks. Show the running/candidate versions, upload progress, verification,
activation confirmation, and final boot outcome. Do not report success just
because all bytes left the browser.

Proposed routes follow the existing versioned management API:

| Route | Behavior |
| --- | --- |
| `GET /api/v1/firmware` | Return authenticated running version, board/layout/source, test/release profile, size limit, availability, and trial-boot/update state. |
| `POST /api/v1/update` | Receive a raw `application/octet-stream` body with a known length; reserve one update job and stream it to the inactive slot. |
| `GET /api/v1/update/job` | Return bounded progress, job ID, candidate identity, and result to an authenticated owner. |
| `DELETE /api/v1/update/job` | Cancel before activation and release job resources; leave the running app selected. |
| `POST /api/v1/update/activate` | Confirm the verified job ID and candidate digest, select it for boot, and schedule restart. |

The routes above are implemented. Job status, cancellation, and activation are
bound to the initiating owner session and local interface address. AP mode is
not required: the same endpoint works through the station/LAN address, including
when the AP is off. A single update reservation covers both interfaces.

1. Require the owner to release keyboard control before admission. Atomically
   reject active or pending control, a network transition, or another update.
2. Reserve update mode across both interfaces. Prevent new control acquisition,
   Wi-Fi reconfiguration, and automatic AP shutdown for the job's bounded
   lifetime. An initial management touch alone is not a sufficient network hold.
3. Clear queued/held input and invalidate leases. When USB is ready, confirm
   the all-keys-up report before flash work; abort if that cannot complete within
   a bounded deadline. An absent USB host must not prevent maintenance.
4. Validate type, length, preliminary headers, and compatibility limits. Stream
   into the inactive slot through `esp_ota_begin()` with the known image length
   and `esp_ota_write()` with a small fixed internal-RAM buffer. Never hold the
   whole image in RAM or accept an image merely because it fits the larger slot.
5. Use bounded asynchronous HTTP request ownership and an update worker so
   flash operations do not monopolize the HTTP server. Keep status and
   cancellation responsive; serialize state changes and use finite receive,
   inactivity, total-job, and staged-image deadlines.
6. On complete receipt, call `esp_ota_end()` under the signed-on-update profile
   and require ESP-IDF's verifier to match the candidate signature-block key
   against the trusted key digest from the running application. A candidate
   that is validly self-signed under any other key must fail. Then enforce the
   signed compatibility checks. Only a fully verified image becomes staged.
   Truncation, cancellation, timeout, invalid metadata, or failure must never
   select it.
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

The fresh-install OTA-data image is intentionally erased. With this no-factory
ESP-IDF v6.1 layout, the bootloader selects `ota_0` and writes its sequence/state
record as `ESP_OTA_IMG_VALID` before entering the application. Missing or unknown
state after bootloader handoff remains an error, not permission for the updater
to assume a valid image. The native SDK-backed test exercises the actual
bootloader selection/initialization functions with mocked storage; CI runs it
with `IDF_PATH` set. The portable native runner explicitly reports this one
check as skipped when `IDF_PATH` is unset, rather than claiming SDK coverage.
This does not replace physical first-install acceptance.

Enable `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` in the wired baseline. On a boot
marked `ESP_OTA_IMG_PENDING_VERIFY`, run bounded diagnostics before calling
`esp_ota_mark_app_valid_cancel_rollback()`:

- Read and validate the OTA baseline's identity and settings without erasing or
   replacing them.
- Initialize the USB service with input released and verify service-task health.
- Establish a usable station interface or protected recovery AP and a functioning
  web-management service.
- Check critical allocation/startup failures and liveness during the trial boot.

Do not require Internet, NTP, a browser reconnect, or USB host enumeration to
accept the image. A powered-off router should permit protected-AP recovery, not
automatically condemn the update. Choose the diagnostic deadline to include
bounded station retry/recovery, and confirm promptly after checks pass.

Web-management liveness uses `web_server_service_healthy()`: the HTTP service
must be started and have a coherent snapshot published by its own task within
500 ms. Do not substitute keyboard-ready status (`web.ready`), which also
requires owner claim and USB host readiness. Tests keep management healthy
without USB enumeration and reject stale or invalid publication.

Commit `CONFIG_BOOTLOADER_WDT_ENABLE=y` and
`CONFIG_BOOTLOADER_WDT_DISABLE_IN_USER_CODE=y` for the OTA profile so the RTC
watchdog remains armed from the bootloader into earliest application startup.
The current `CONFIG_BOOTLOADER_WDT_TIME_MS` is 60,000 ms. Keep that watchdog
armed without feeding it during the bounded 45-second validation window and
do not disable it before the image is confirmed. An application timer may coordinate a responsive
failure path, but it cannot replace this watchdog because stopped startup or a
hung scheduler cannot service a timer.

On an explicit failure, use `esp_ota_mark_app_invalid_rollback_and_reboot()`.
On a hang, the armed watchdog must reset the device so the bootloader can reject
the still-unconfirmed image and fall back on the next boot. Reset or power loss
during an unconfirmed trial likewise triggers fallback. These checks do not
prove every keyboard behavior correct; post-update USB/browser acceptance
remains necessary.

Do not erase the previous healthy image after confirmation. It is reused only
as the inactive target of a later update. Ensure the initial wired `ota_0` is a
usable fallback before admitting the first OTA, and test that first rollback
specifically, not only later A/B cycles. Never allow another update while the
running image remains pending verification.

Rollback switches applications, not NVS. Within the new OTA baseline, preserve
the 64 KiB NVS layout, settings schemas, and 10-iteration credential policy.
Firmware requiring the old layout or incompatible 100,000-iteration credentials
must not be accepted as an OTA candidate. Later settings-format changes must
remain readable by the retained fallback, including after the new app is confirmed;
deferring a destructive schema change until confirmation alone is insufficient.

## Fresh Installation And Wired Replacement

The installation contract starts with an erased device. The previous partition
table, NVS records, credentials, and firmware version are not inputs to the
installer. There is no source-to-target layout mapping, data conversion,
preservation/restore step, or dedicated migration utility. An existing device
is treated as a new device after its explicitly approved full reset.

Use the standard ESP-IDF/esptool erase/flash operations and the existing
installation/provisioning workflow. Adapt their target-layout and artifact
validation for the new normal build, including OTA metadata and fresh 64 KiB
NVS; do not create a separate migration command. Keep legacy artifact guards
identifiable rather than silently changing what old bundles mean. The current
`--replace-nvs` option alone does not install or validate this new layout.

The same procedure applies to a new board and a later wired full replacement:

1. Confirm the intended device, detected capacity, security state, target profile,
   stable power, and usable ROM recovery. Verify the authenticated public bundle
   and pinned application signing key before writing. For an existing device,
   explicitly confirm a full erase and loss of all ownership and saved settings.
2. Prepare and durably retain fresh provisioning credentials and the private
   64 KiB NVS image with the new KDF cost. Then perform the approved erase, if
   needed, with the standard tooling. Do not burn eFuses.
3. Flash the new bootloader, partition table, signed `ota_0`, initialized OTA
   metadata, and locally generated NVS at validated target offsets. Leave the
   second app slot and unused PHY reservation erased. Re-read and verify every
   written image, including the signed application and fresh NVS, before boot.
4. Boot, complete fresh owner claim and Wi-Fi setup, and check login, radio, USB,
   and first-update rollback readiness. RF calibration is recreated as needed.
   Subsequent OTA updates and rollback preserve these new credentials/settings.

An optional private backup made with existing tools before reset is a user
precaution, not an installation input, an acceptance prerequisite, or a migration
feature to implement. It contains secrets and must remain outside the repository.
An interrupted wired installation uses normal ROM recovery and the retained
new install/provisioning artifacts; never regenerate credentials automatically
on retry. The wired operation itself is not power-failure-safe. This document
does not authorize an actual erase or flash.

Normal OTA is a separate, non-destructive operation on this established layout.
It requires neither layout reset nor owner claim/Wi-Fi setup, and a failed OTA
must never trigger a factory reset.

## Packaging And CI Work

The [current CI workflow](../.github/workflows/ci.yml) now validates the
implementation as follows:

- Make OTA support and the new layout the normal defaults for the selected
   board/profile. One clean normal build must generate both wired replacement
   and OTA outputs with identical signed application bytes. Validate the final
   image against both slots, headroom, and compatibility metadata.
- Validate the effective PHY settings against the embedded-data profile above;
   reject partition-backed PHY builds or unexpected PHY image roles instead of
   distributing an incomplete bootstrap bundle.
- Reuse the existing Node/SDK installer validation patterns, with tests for new
   roles, malformed tables, signed images, private snapshots, explicit reset
   authorization, and fresh 64 KiB NVS. Separately test settings preservation
   during OTA and rollback. Use ESP-IDF parsers and signature tools instead of
   custom cryptography.
- Check that firmware, provisioning, installer validation, preview, and test
   fixtures agree on the 10-iteration policy. Reject incompatible legacy
   credentials and keep the existing login/access-control tests.
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
coordinate maintenance gating with network and USB ownership. Startup owns
trial-boot diagnostics. The existing preview and test runners now cover this
component; no separate migration utility is introduced.

## Software Implementation Record

- [Normal build defaults](../sdkconfig.defaults) and [partition table](../partitions.csv)
   establish the 16 MiB layout. Generic and XinluCity builds both produce a
   987,136-byte signed image in current local validation, with 84% slot headroom.
   The bootloader is 21,232 bytes, with 35% of its reserved region free. These
   are test-key development builds, not approved device releases.
- [Firmware update component](../components/firmware_update/firmware_update.c)
   streams to the inactive slot, verifies the SDK signature and exact image
   length, enforces the signed descriptor, and stages explicit activation.
   Deadlines are 10 seconds without upload progress, 300 seconds total, and
   120 seconds staged. The USB release barrier is bounded to two seconds.
- [Network maintenance admission](../components/network/network.c) accepts
   either a live AP or station address and excludes control/network changes.
   No AP activation or Internet access is required for station-mode OTA.
- Pending-verification trial boots require eight consecutive healthy samples 250 ms apart, including
   network-worker progress, readable saved settings, a live HTTP service, and
   USB-task progress without host enumeration. The RTC watchdog stays armed
   until confirmation; a failed trial requests rollback without resetting NVS.
   Already-confirmed boots stop the startup watchdog during updater initialization,
   before USB/network/web startup can fail. Updates remain unavailable until
   service initialization finishes, without repeating the trial task or entering
   its rollback path.
- [Artifact generation](../tools/ota_artifacts.py) runs as part of every normal
   build, verifies the actual RSA signature, signs the install manifest, and
   checks equality between the wired ZIP's application and OTA payload. Private
   keys and NVS are excluded. CI keys are test-only; trusted releases use an
   independently supplied local RSA-3072 key outside the checkout.
- [Existing installation tooling](../tools/install-device.mjs) supports explicit
   `--reset-layout`, independent public-key verification, fresh provisioning,
   and complete readback checks. It does not inspect or convert an old layout.
   See the [sender guide](sender-installation.md) for commands and key handling.
- The standalone `/ota` page provides owner login, upload, progress, cancellation,
   separate activation, re-login, and running-version confirmation, with no
   navigation to or from the keyboard/network settings UI. Lost responses are
   resolved through status without repeating activation or keyboard control.
- Local validation includes 12 ASan/UBSan native suites, 25 keyboard-model tests,
   61 SDK-backed installer/artifact tests, and Chromium/WebKit browser/API tests.
   The native harness exercises the actual updater with mocked SDK boundaries;
   the browser preview simulates signature and reboot outcomes. Real signature
   verification is exercised separately with Espressif's SDK. Phone and desktop
   screenshots were checked for overlap. CI lint and editor diagnostics are clean.

Hardware latency, NVS occupancy, heap/stack under real flash load, full-capacity
operation, power-loss behavior, first-update rollback, and ROM recovery remain
pending. No physical device, production signing key, eFuse, or release publication
was changed during implementation.

## Acceptance Gates

Software checks cover the contracts below; all physical OTA gates remain pending.
Host tests and a successful build are not substitutes for the device checks.

| Gate | Required evidence |
| --- | --- |
| Flash layout | Validate 64 KiB NVS, 8 KiB OTA metadata, two aligned 6 MiB app slots, non-overlap, the 16 MiB boundary, bootloader fit, and at least 20% signed-image headroom. |
| Dual-output normal build | One clean normal build produces the wired replacement bundle and OTA payload without switching firmware configurations or rebuilding. Verify identical signed application bytes, length, SHA-256, version, source revision, and compatibility identifiers; both installation methods lead to OTA-capable firmware. |
| Artifact isolation | OTA output contains only the signed app and public metadata; no install images, NVS, secrets, or address-selection instructions. |
| Page separation | Direct `/ota` access supports owner login and the complete update/reboot flow on AP and station. Neither page links to the other; `/` loads no OTA controller or update polling, and `/ota` loads no keyboard controller or control-acquisition UI. |
| PHY initialization | Verify embedded-data build settings and reject mismatched profiles; clean installation starts radio with erased unused `phy_init` and recreates absent NVS calibration records. |
| Fresh installation | Install on an erased device with the normal flash/provisioning workflow, without old-layout metadata, old credentials, a backup, or a migration tool as inputs. Require explicit approval for erasing an existing board; retain fresh credentials, verify every written range, and complete fresh claim/Wi-Fi setup. |
| Login cost and latency | Verify 10 iterations throughout firmware/tooling and in freshly generated records, correct/wrong-password behavior, rejected legacy costs, and unchanged online rate limits. Record on-device KDF and end-to-end login timings; do not claim unmeasured speedups. |
| Compatibility and bounds | Reject malformed, oversized, truncated, wrong-chip/product/layout/bootstrap/schema images and disallowed versions. Check final signed size against both slots. |
| Bootstrap provenance | Start from an installer trust root obtained outside the candidate bundle. Reject a modified or self-declared install manifest and any altered bootloader, partition table, `ota_0`, OTA-data initializer, security profile, or write offset; re-read every written range against the authenticated manifest before first boot. |
| OTA authenticity and key continuity | For clean bootstrap, pin the expected release public-key fingerprint outside the candidate bundle and verify the installed `ota_0` with it. For every routine OTA, require ESP-IDF's verifier to compare the candidate signature-block key with the trusted key from the running application. Reject unsigned, corrupted, altered-descriptor, and validly self-signed wrong-key images even if public metadata is changed to match. |
| Management authorization | On both AP and station interfaces, upload, status, cancellation, and activation reject anonymous, expired, revoked, and cross-interface sessions without leaking job data. Reject invalid Host/Origin values on every applicable request and missing or invalid CSRF tokens on every mutation. |
| Admission and concurrency | Reject active/pending keyboard control, concurrent uploads and network jobs; AP hold, expiry, cancellation, and status remain bounded and race-free. |
| Interrupted update | Power or network loss during erase/write/verification leaves the running image bootable and input disarmed; no partial image is selected. |
| Trial boot | Exercise power loss around boot selection and trial boot, explicit failure, first-update rollback, later A/B cycles, and successful confirmation. For deliberate hangs both before and after scheduler startup, verify the armed RTC watchdog resets the device and triggers rollback without relying on an application timer. |
| Persistent settings | Only the explicitly approved clean installation replaces credentials/settings. Identity, ownership, and saved Wi-Fi survive every subsequent OTA and fallback; incompatible schemas or KDF policies do not cause silent replacement or factory reset. |
| Real keyboard behavior | AP/STA browser flows, host absent/suspended, all-keys-up before update, reconnect/login, and explicit reacquisition work on actual USB hardware. |
| Resource budget | Measure free internal heap, stack high-water marks, HTTP responsiveness, watchdog behavior, power stability, and signed-image headroom under update load. Record NVS usage after provisioning, claim, and repeated network changes. |
| Full-capacity and recovery | Validate the proposed high flash addresses and wired recovery on the identified board before accepting a 16 MiB production profile. |

## Rollout And Open Decisions

Steps 1-5 are implemented with local software checks. Step 6 has local test and
build evidence; device acceptance is pending. Step 7 supports local signed
dual-output builds, while trusted-key custody and publication remain operator
gates. The original implementation sequence is retained for traceability:

1. **Freeze the layout and profile.** Validate the proposed CSV, bootloader
   headroom, and image budget; decide any concrete diagnostic-storage need now.
   Make the custom table and OTA support normal reproducible 16 MiB build
   defaults, with layout/profile IDs.
2. **Align the login policy.** Change firmware, provisioning, installer
   validation, preview, and existing tests to 10 iterations together. Cover
   fresh credentials and rejected legacy costs; do not flash this change alone
   onto old NVS or add an automatic reset path.
3. **Build the OTA foundation and artifacts.** Add the `app_update` dependency,
   signed-app verification, rollback/watchdog startup handling, versioned
   compatibility metadata, and both wired replacement and OTA outputs from each
   normal build. Package the same signed application in both; use test-only keys
   for ordinary CI and verify final image sizes and cross-artifact equality.
4. **Adapt normal fresh installation.** Update existing packaging/provisioning
   validators for the new target layout, signed images, OTA metadata, and fresh
   64 KiB NVS. Use the standard erase/flash workflow with explicit reset approval
   and write verification. Do not add migration tools, source-layout handling,
   or old-data conversion/preservation.
5. **Implement local OTA and its UI.** Add bounded upload/status/cancel/activate
   handling, signed compatibility checks, maintenance exclusion, and all-keys-up
   behavior. Show upload, verification, reboot, and actual boot outcome; keep
   firmware/UI together and require login plus explicit control after reboot.
6. **Run acceptance checks.** Run focused native, installer, and browser tests
   and both existing CI gates. With separate hardware-write approval, capture
   an old login baseline if available, perform the fresh reset/install, and validate
   16 MiB addressing, NVS usage, new login latency, USB/AP/STA behavior, interrupted
   uploads, trial-boot failures, first/later rollback, and wired recovery.
7. **Prepare repeatable releases.** Finalize signing-key custody and recovery,
   release/version policy, and durable distribution. Publish both normal-build
   wired replacement and OTA artifacts only after acceptance; leave Internet discovery and
   hardware security provisioning outside this increment.

The implemented layout ID is `kb16-ab6-nvs64-v1`; board IDs are
`esp32s3-generic-16m` and `xinlucity-s3-nano-16m`. No diagnostic partition is
allocated in v1. Numeric release ordering and bounded update/boot timeouts are
implemented. Remaining operator decisions are signing-key custody/recovery,
acceptable measured login latency, explicit hardware-write approval, and trusted
release publication after acceptance. GitHub Releases is the intended durable
distribution location; no release has been published by this work.
The 6 MiB slots, 64 KiB NVS, reset-based transition, and 10-iteration personal-use
policy are the recorded direction, subject to validation rather than silent
changes to the running device. Implementation and PR preparation were authorized;
device writes, production-key provisioning, and release publication were not.

## References

- [ESP-IDF v6.1 OTA and rollback](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/ota.html)
- [ESP-IDF v6.1 partition tables](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/partition-tables.html)
- [ESP-IDF v6.1 PHY configuration](https://github.com/espressif/esp-idf/blob/v6.1/components/esp_phy/Kconfig)
- [Signed apps without hardware Secure Boot](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/security/secure-boot-v2.html#signed-app-verification-without-hardware-secure-boot)