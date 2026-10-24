# USB Wi-Fi profile maintenance

`tools/network_nvs.py` is a standalone, host-side read/modify/write tool for an
ESP32-S3's existing default `nvs` partition. It supports list, add, update, delete,
and atomic-in-memory batch merge of at most ten 2.4 GHz WPA2-Personal profiles.
It never writes an application, bootloader, or partition table. It enters ROM
serial download mode using esptool, runs esptool's RAM stub, then attempts a
hard reset on success **and on errors after connection**. Listing also resets the
board. Close serial monitors and stop firmware writes before running it.

**Multi-network-capable firmware is required.** Older firmware ignores the new
`profiles0`/`profiles1` records; preloading these records does not upgrade the
firmware. Station connections also remain gated on the initial ownership claim:
complete first-owner setup once before expecting saved profiles to connect.
USB preloading neither claims the device nor bypasses that ownership gate.

## Important: physical writes are not power-loss atomic

**Do not use this tool when interruption of NVS writes is unacceptable.** esptool
erases flash sectors before writing them. Both update phases rewrite the entire
NVS partition, including sectors containing identity, ownership, and unrelated
settings. A cable/power failure can therefore destroy those settings and both
network slots, even though the final image preserves their original raw entries.
This is **not** the firmware's power-loss-safe NVS transaction mechanism.

The tool refuses mutations unless all of these are explicit:

* `--execute`;
* `--allow-nvs-rewrite`, acknowledging the above risk;
* a **new**, private, outside-repository `--backup-dir`.

It durably saves and rereads the original NVS backup before any flash write.
It writes the inactive profile data first and verifies a complete readback.
Only then does it write the active-slot selector and verify another complete
readback. This ordering detects ordinary failures but **does not** make
whole-partition erases power-loss safe. Failed readback stops further writes.
Keep the backup until the device has rebooted and its identity, ownership and
network behavior have been checked. The tool does not automatically restore a
backup on error: another interrupted restore would carry the same risk.

If you require strict power-failure preservation, use firmware-managed NVS
updates instead; do not pass the acknowledgement flag.

## Environment and device requirements

Activate the ESP-IDF environment configured by `tools/setup-dev.sh` or your EIM
activation script. The Python interpreter needs the SDK's esptool; the tool
reuses the installer's validated esptool **5.3.1 or 5.4.0** and ESP-IDF
partition-table parser. No extra Python dependency is required.

Use `--idf-path /path/to/esp-idf` if `IDF_PATH` is not set. Always supply an
explicit serial port and **12 lowercase hex digits** for the independently known
factory **base MAC** in `--device-id`; an SSID, station MAC override or USB
serial-number string is not that identity. No port enumeration/auto-selection
or unvalidated device writes are performed.

Example read-only command (replace the example MAC and port):

```sh
python tools/network_nvs.py list \
  --port /dev/ttyACM0 --device-id 123456789abc
```

The connected chip must be ESP32-S3, in normal ROM download mode, without secure
boot or flash encryption. The SDK validates the on-device partition table at
`0x8000`; specify `--partition-table-offset 0x...` only for a known custom
layout. The tool rejects encrypted partitions, a missing/read-only default
`nvs`, overlaps, misalignment, or flash-boundary violations.

Supported NVS pages are unencrypted version 2 with valid page/entry/payload CRCs,
normal active/full states, and complete records. Older page versions, in-progress
recovery states, corrupt/ambiguous entries, unsupported network-slot types, and
unsupported network blob versions are refused, **not regenerated or discarded**.
The tool needs at least two completely erased NVS pages: one for the new
records and one left as the firmware's GC reserve. It does not compact, evict
profiles, repair NVS, or reclaim erased-but-not-blank pages. Boot the firmware
for normal recovery/GC or choose a firmware-side update when space is
insufficient. Each successful offline mutation consumes one erased page.

Both current layouts (`partitions.csv` and `partitions.xiao-esp32s3.csv`) place
NVS at `0x9000` with size `0x10000` (16 pages). The SDK integration test generates
the installer's initial identity records at that exact size: one page is used,
15 are erased, and a ten-profile update succeeds leaving 14 erased pages.
This is not a guarantee about a running device's accumulated NVS data: valid
firmware-managed NVS can have only its single GC reserve erased, in which case
this deliberately conservative tool refuses the mutation. Partition size alone
cannot establish current free-page availability; no hardware dump was inspected.

Unknown key types in otherwise valid records are retained as raw bytes, not
translated through an incomplete CSV type mapping. Existing namespace numbers,
device identity, owner records, legacy network keys, and unrelated entry data
are preserved. Only obsolete destination-slot records and the old selector are
marked erased; page state headers are updated as required for the appended
page. Unsupported data is rejected rather than silently dropped.

## Credentials and commands

Never place passwords in command-line arguments, environment variables, shell
history, or repository files. There is deliberately no `--password` flag.
Use an interactive hidden prompt, or `--credentials` pointing to an
outside-repository local JSON file owned by you with mode `0600` (or stricter).
Symlinks, nonregular files, duplicate JSON fields, and group/world-readable
files are refused. File-based credential permission checks currently require
POSIX; use the interactive prompt on Windows. Prompting requires a terminal.
Backups contain plaintext credentials and identity/owner data: protect them
like the credential file and avoid shared/synchronized directories.

Prepare a private parent directory outside the repository, then use an editor
to create the credential file; do not enter the password in a shell command:

```sh
mkdir -m 700 "$HOME/keyboard-private"
(umask 077; touch "$HOME/keyboard-private/profile.json")
# Open that file in your editor and enter a JSON object as described below.
```

An add file is a single object:

```json
{"ssid": "Example 2.4GHz", "password": "replace-in-private-file"}
```

For non-UTF-8 or byte-exact SSIDs use `ssid_hex` instead of `ssid`, never both:

```json
{"ssid_hex": "ff77696669", "password": "replace-in-private-file"}
```

SSID strings are UTF-8 encoded; byte lengths must be 1–32 with no NUL bytes.
Passwords must be 8–63 printable ASCII bytes. Open networks, WPA enterprise,
and 64-character hexadecimal PSKs are unsupported. This offline tool cannot
detect AP band/security or prove connectivity: choose a **2.4 GHz WPA2-Personal**
AP. New or changed credentials are always unverified until firmware connects
successfully. No command prints passwords; `list` and mutation summaries use
`"[redacted]"`.

### Add

```sh
python tools/network_nvs.py add \
  --port /dev/ttyACM0 --device-id 123456789abc \
  --credentials "$HOME/keyboard-private/profile.json" \
  --execute --allow-nvs-rewrite \
  --backup-dir "$HOME/keyboard-private/backup-add-001"
```

For a hidden password prompt omit `--credentials` and provide
`--ssid 'Example 2.4GHz'` or `--ssid-hex ...`. An existing exact SSID is an error;
use `update` instead. New profiles append after existing profiles.

### Update / rename

Select the **existing** SSID with `--ssid` or `--ssid-hex`. The private update
file can contain `password`, `ssid`/`ssid_hex` for a rename, or both:

```json
{"ssid": "Renamed 2.4GHz", "password": "replace-in-private-file"}
```

```sh
python tools/network_nvs.py update \
  --port /dev/ttyACM0 --device-id 123456789abc --ssid 'Example 2.4GHz' \
  --credentials "$HOME/keyboard-private/profile.json" \
  --execute --allow-nvs-rewrite \
  --backup-dir "$HOME/keyboard-private/backup-update-001"
```

An omitted field preserves its value. An actual SSID/password change clears
verification and moves the profile to the unverified tail; unchanged credentials
preserve ordering and verification. Renaming onto another existing SSID fails.
Without a file, update prompts for a new password; a blank prompt preserves it
and requires an explicit settings change.

### Delete

```sh
python tools/network_nvs.py delete \
  --port /dev/ttyACM0 --device-id 123456789abc --ssid 'Renamed 2.4GHz' \
  --execute --allow-nvs-rewrite \
  --backup-dir "$HOME/keyboard-private/backup-delete-001"
```

The selector must exist. Deleting the last profile forces station mode off.

### Batch import (merge, never replace all)

The credential file is a JSON **array** of profile objects:

```json
[
  {"ssid": "Home 2.4GHz", "password": "replace-in-private-file"},
  {"ssid_hex": "4f6666696365", "password": "replace-in-private-file"}
]
```

```sh
python tools/network_nvs.py import \
  --port /dev/ttyACM0 --device-id 123456789abc \
  --credentials "$HOME/keyboard-private/profiles.json" \
  --execute --allow-nvs-rewrite \
  --backup-dir "$HOME/keyboard-private/backup-import-001"
```

Import merges by exact SSID bytes: matching unchanged credentials retain their
position/verification, changed credentials move to the tail unverified, and new
profiles append in import order. Duplicate import SSIDs, malformed entries or a
result above ten cause the **entire merge to fail before any flash write**.
There is no eviction. This logical batch atomicity is not power-failure atomicity.

### Hostname and station mode

Mutations preserve the existing hostname and station flag unless explicitly
changed with `--hostname NAME` and/or `--station 0|1`. Adding/importing into an
empty profile set enables station mode unless `--station 0` is supplied.
An empty resulting set always disables station mode. Hostname storage allows up
to 32 non-NUL bytes; choose a hostname appropriate for your network. `list`
cannot change settings.

## Firmware storage contract

Namespace: `kb_network`. New keys:

* `profiles0`, `profiles1`: NVS blob, **1017 bytes** each;
* `profiles_active`: NVS `u8`, value 0 or 1.

The selected new-format blob is preferred. If no new selector exists, the tool
reads legacy `active` (`u8`) and `slot0`/`slot1` (blob). Legacy keys are never
modified. Invalid selected new data is refused rather than masking corruption
by importing legacy settings.

New packed encoding (no native structs, no implicit alignment):

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 1 | Version = 2 |
| 1 | 1 | Station = 0 or 1 |
| 2 | 1 | Profile count = 0–10 |
| 3 | 1 | Reserved = 0 |
| 4 | 33 | Hostname, NUL terminated and zero padded |
| 37 | 980 | Exactly ten 98-byte profile entries |

Each entry is `SSID[33]`, `password[64]`, `verified[1]` (0/1). Used strings
are NUL terminated with zero padding. Unused entries are entirely zero.
Exact duplicate SSID bytes are forbidden. Successful MRU profiles stay at the
front; offline unverified profiles append. `encode_settings`,
`decode_settings`, and `decode_legacy` are importable for cross-language fixture
generation/testing.

Legacy decoding is exactly 136 bytes: little-endian `u32 version=1` at offset 0,
station at 4, hostname[33] at 5, SSID[33] at 38, password[64] at 71, zero padding
at 135. Imported legacy credentials are unverified.

## Backup recovery and validation

Each new backup directory contains `nvs-backup.bin` and `nvs-backup.json`.
Metadata records factory base MAC, offset, size, SHA-256 and the partition-table
digest. The binary is the original entire NVS partition, not only network keys.
To recover, independently verify the device MAC, table digest, exact partition
offset/size, binary hash, and unencrypted state before using a separately
reviewed NVS-only restore procedure. Do not flash this binary at address zero or
use an installer option that replaces identity. Recovery rolls back **all**
NVS data to the backup, including ownership changes made since it was taken.

Focused host tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover \
  -s tools -p network_nvs_test.py -v
```

Tests exercise packed format boundaries, legacy migration, MRU/verification
semantics, batch refusal, unknown-type preservation, mocked backup/write/reset
and refusal paths, and the real SDK NVS generator/parser and partition parser
when installed. SDK integration tests explicitly skip if those SDK modules are
unavailable; activate ESP-IDF and set `IDF_PATH` to run them. No test accesses
hardware. Physical USB behavior and actual radio connectivity require later
on-device validation.

### Optional C/Python ABI fixture

The Python test also looks for the native binary
`.cache/tests/network_profiles_fixture_test`. If absent, that individual test
explicitly skips. If present, it runs:

```sh
.cache/tests/network_profiles_fixture_test \
  --emit-fixture .cache/tests/network_profiles_fixture.bin
```

The native binary must handle this optional argument by emitting **exactly
1017 raw bytes**, with no text prefix, and returning zero. Zero-initialize a
`network_profiles_t`, then set version=2, station=1, count=2,
hostname=`fixture-host`, and these two profiles:

1. SSID bytes `fixture-main`, password `fixture-pass`, verified=1.
2. SSID bytes `ff 77 69 66 69` (hex; `0xff` followed by `wifi`), password
   `second-pass`, verified=0.

All remaining fields, unused entries and string padding must remain zero.
The output path is resolved relative to the repository root. Normal invocation
without this flag should continue to run the binary's native assertions.
Python decodes the emitted bytes, compares every field to this fixture contract,
and asserts byte-for-byte equality with its independent encoder. A missing
output, nonzero exit, timeout, changed fixture value or invalid encoding fails.
The generated fixture contains only these public test values.

Public codec API in `tools/network_nvs.py`:

```python
Profile(ssid: bytes, password: bytes, verified: bool = False)
Settings(station: bool = False, hostname: bytes = b"", profiles: tuple = ())
encode_settings(settings: Settings)  # returns exactly 1017 bytes
decode_settings(data: bytes)        # returns Settings; rejects noncanonical data
decode_legacy(data: bytes)          # 136-byte legacy blob -> Settings
```

Import with `tools` on `sys.path` (for example `PYTHONPATH=tools`). Codec
validation failures raise `ToolError`, a `ValueError` subclass, without exposing
credential values.
