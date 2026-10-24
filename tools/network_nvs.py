#!/usr/bin/env python3
"""Offline, explicitly acknowledged NVS-only USB Wi-Fi maintenance."""

import argparse
import contextlib
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import zlib

from install_device import (
    create_private_directory, flash_capacity, load_sdk, private_write,
)

PAGE = 4096
BLOB_SIZE = 1017
NAMESPACE = b"kb_network"
ACTIVE_KEY = b"profiles_active"
SLOT_KEYS = (b"profiles0", b"profiles1")


class ToolError(ValueError):
    """A validation error whose message contains no credential values."""


def require(condition, message):
    if not condition:
        raise ToolError(message)


@dataclass(frozen=True)
class Profile:
    ssid: bytes
    password: bytes
    verified: bool = False


@dataclass(frozen=True)
class Settings:
    station: bool = False
    hostname: bytes = b""
    profiles: tuple = ()


def crc(data):
    return zlib.crc32(data, 0xFFFFFFFF) & 0xFFFFFFFF


def cfield(data, width, label):
    require(isinstance(data, bytes) and len(data) < width and b"\0" not in data,
            f"Invalid {label}")
    return data.ljust(width, b"\0")


def unfield(data, label):
    value, separator, padding = data.partition(b"\0")
    require(bool(separator) and not any(padding), f"Invalid {label} padding")
    return value


def validate_profile(profile):
    require(1 <= len(profile.ssid) <= 32 and b"\0" not in profile.ssid, "Invalid SSID")
    require(8 <= len(profile.password) <= 63 and
            all(32 <= byte <= 126 for byte in profile.password), "Invalid WPA2 password")
    require(type(profile.verified) is bool, "Invalid verified field")


def validate_hostname(hostname):
    require(isinstance(hostname, bytes) and 1 <= len(hostname) <= 32 and
            re.fullmatch(rb"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", hostname) is not None and
            hostname != b"localhost",
            "Invalid hostname; use --hostname with 1-32 lowercase letters, digits or interior hyphens")


def encode_settings(settings):
    require(type(settings.station) is bool and len(settings.profiles) <= 10, "Invalid settings")
    require(not settings.station or bool(settings.profiles), "Station mode requires a saved network")
    validate_hostname(settings.hostname)
    require(len({p.ssid for p in settings.profiles}) == len(settings.profiles), "Duplicate SSID")
    result = bytes((2, int(settings.station), len(settings.profiles), 0))
    result += cfield(settings.hostname, 33, "hostname")
    for profile in settings.profiles:
        validate_profile(profile)
        result += cfield(profile.ssid, 33, "SSID") + cfield(profile.password, 64, "password")
        result += bytes((int(profile.verified),))
    return result + bytes(98 * (10 - len(settings.profiles)))


def decode_settings(data):
    require(len(data) == BLOB_SIZE and data[0] == 2 and data[1] in (0, 1) and
            data[2] <= 10 and data[3] == 0, "Unsupported profile blob")
    profiles = []
    for index in range(10):
        entry = data[37 + index * 98:37 + (index + 1) * 98]
        if index >= data[2]:
            require(not any(entry), "Nonzero unused profile")
            continue
        require(entry[97] in (0, 1), "Invalid verified flag")
        profiles.append(Profile(unfield(entry[:33], "SSID"),
                                unfield(entry[33:97], "password"), bool(entry[97])))
    settings = Settings(bool(data[1]), unfield(data[4:37], "hostname"), tuple(profiles))
    require(encode_settings(settings) == data, "Noncanonical profile blob")
    return settings


def decode_legacy(data):
    require(len(data) == 136 and data[:4] == b"\1\0\0\0" and
            data[4] in (0, 1) and data[135] == 0, "Unsupported legacy network blob")
    hostname = unfield(data[5:38], "hostname")
    ssid = unfield(data[38:71], "SSID")
    password = unfield(data[71:135], "password")
    require(bool(ssid) == bool(password), "Incomplete legacy profile")
    settings = Settings(bool(data[4]), hostname,
                        (Profile(ssid, password),) if ssid else ())
    encode_settings(settings)
    return settings


@dataclass(frozen=True)
class Record:
    page: int
    index: int
    namespace: int
    kind: int
    span: int
    chunk: int
    key: bytes
    value: bytes


class RawNVS:
    """Retain raw entries, including unknown types; never export/regenerate a CSV."""

    def __init__(self, image):
        require(len(image) >= 3 * PAGE and len(image) % PAGE == 0, "Invalid NVS size")
        self.image = image
        self.records = []
        self.free = []
        self.pages = []
        sequences = set()
        for offset in range(0, len(image), PAGE):
            page = image[offset:offset + PAGE]
            if page == b"\xff" * PAGE:
                self.free.append(offset)
                continue
            state, sequence = struct.unpack_from("<II", page)
            require(state in (0xFFFFFFFE, 0xFFFFFFFC) and page[8] == 0xFE and
                    page[9:28] == b"\xff" * 19 and
                    crc(page[4:28]) == struct.unpack_from("<I", page, 28)[0],
                    "Unsupported, encrypted, interrupted, or corrupt NVS page")
            require(sequence not in sequences and sequence < 0xFFFFFFFD,
                    "Unsupported NVS page sequence")
            sequences.add(sequence)
            self.pages.append((sequence, offset, state))
        require(len([p for p in self.pages if p[2] == 0xFFFFFFFE]) <= 1,
                "Multiple active NVS pages require firmware recovery first")
        for _, offset, _ in sorted(self.pages):
            page = image[offset:offset + PAGE]
            index = 0
            while index < 126:
                state = self.entry_state(page, index)
                require(state != 1, "Invalid NVS entry bitmap")
                if state != 2:
                    if state == 3:
                        require(page[64 + index * 32:96 + index * 32] == b"\xff" * 32,
                                "Interrupted NVS entry; boot firmware for recovery first")
                    index += 1
                    continue
                start = 64 + index * 32
                entry = page[start:start + 32]
                namespace, kind, span, chunk = entry[:4]
                require(span >= 1 and index + span <= 126 and
                        all(self.entry_state(page, i) == 2 for i in range(index, index + span)),
                        "Incomplete NVS entry")
                require(crc(entry[:4] + entry[8:]) == struct.unpack_from("<I", entry, 4)[0],
                        "NVS entry CRC mismatch")
                key, separator, _ = entry[8:24].partition(b"\0")
                require(bool(key) and bool(separator), "Invalid NVS key")
                value = entry[24:32]
                if kind in (0x21, 0x41, 0x42):
                    size = struct.unpack_from("<H", value)[0]
                    require(span == 1 + (size + 31) // 32, "Invalid NVS payload span")
                    value = page[start + 32:start + 32 + size]
                    require(crc(value) == struct.unpack_from("<I", entry, 28)[0],
                            "NVS payload CRC mismatch")
                elif kind in (1, 2, 4, 8, 0x11, 0x12, 0x14, 0x18, 0x48):
                    require(span == 1, "Invalid primitive NVS span")
                self.records.append(Record(offset, index, namespace, kind, span, chunk, key, value))
                index += span
        self.namespaces = {}
        for record in self.records:
            if record.namespace == 0:
                require(record.kind == 1 and 0 < record.value[0] < 255,
                        "Unsupported namespace declaration")
                require(record.key not in self.namespaces and
                        record.value[0] not in self.namespaces.values(), "Duplicate NVS namespace")
                self.namespaces[record.key] = record.value[0]
        require(all(r.namespace == 0 or r.namespace in self.namespaces.values() for r in self.records),
                "NVS entry has no namespace")
        identities = [(r.namespace, r.key, r.kind, r.chunk if r.kind == 0x42 else 255)
                      for r in self.records]
        require(len(set(identities)) == len(identities), "Duplicate NVS entries require recovery")
        for record in self.records:
            if record.kind in (0x42, 0x48):
                self.blob(record.namespace, record.key)

    @staticmethod
    def entry_state(page, index):
        return (page[32 + index // 4] >> ((index % 4) * 2)) & 3

    def find(self, namespace, key):
        return [r for r in self.records if r.namespace == namespace and r.key == key]

    def blob(self, namespace, key):
        records = self.find(namespace, key)
        old = [r for r in records if r.kind == 0x41]
        indexes = [r for r in records if r.kind == 0x48]
        require(not (old and indexes) and len(old) <= 1 and len(indexes) <= 1,
                "Ambiguous NVS blob")
        if old:
            require(len(records) == 1, "Mixed NVS blob types")
            return old[0].value
        require(len(indexes) == 1, "Missing or unsupported NVS blob")
        index = indexes[0]
        size, count, start = struct.unpack_from("<IBB", index.value)
        chunks = [r for r in records if r.kind == 0x42]
        require(count > 0 and start + count <= 256 and len(chunks) == count and
                len(records) == count + 1, "Incomplete or mixed NVS blob")
        require({r.chunk for r in chunks} == set(range(start, start + count)),
                "Missing NVS blob chunk")
        value = b"".join(r.value for r in sorted(chunks, key=lambda r: r.chunk))
        require(len(value) == size, "Invalid NVS blob size")
        return value

    def selected(self, key):
        namespace = self.namespaces.get(NAMESPACE)
        records = self.find(namespace, key) if namespace is not None else []
        if not records:
            return None
        require(len(records) == 1 and records[0].kind == 1 and records[0].value[0] in (0, 1),
                "Invalid active-slot flag")
        return records[0].value[0]

    def settings(self):
        namespace = self.namespaces.get(NAMESPACE)
        active = self.selected(ACTIVE_KEY)
        if active is not None:
            return decode_settings(self.blob(namespace, SLOT_KEYS[active]))
        legacy = self.selected(b"active")
        if legacy is not None:
            return decode_legacy(self.blob(namespace, (b"slot0", b"slot1")[legacy]))
        require(not any(r.key in SLOT_KEYS + (b"slot0", b"slot1") for r in
                        self.records if r.namespace == namespace),
                "Network slots without active flag require recovery")
        return Settings()


def make_entry(namespace, kind, key, value, span=1, chunk=255):
    require(0 < len(key) < 16, "Invalid NVS key length")
    entry = bytes((namespace, kind, span, chunk)) + bytes(4)
    entry += key.ljust(16, b"\0") + value.ljust(8, b"\xff")
    return entry[:4] + struct.pack("<I", crc(entry[:4] + entry[8:])) + entry[8:]


def append_record(page, index, entry, payload=b""):
    span = entry[2]
    require(index + span <= 126, "New NVS page is full")
    start = 64 + index * 32
    page[start:start + 32] = entry
    page[start + 32:start + span * 32] = payload.ljust((span - 1) * 32, b"\xff")
    for item in range(index, index + span):
        page[32 + item // 4] &= ~(1 << ((item % 4) * 2))
    return index + span


def erase_records(image, records):
    for record in records:
        for index in range(record.index, record.index + record.span):
            image[record.page + 32 + index // 4] &= ~(3 << ((index % 4) * 2))


def plan_update(image, settings):
    """Two logical commits; physical partition rewrites are NOT power-loss atomic."""
    old = RawNVS(image)
    old.settings()
    blob = encode_settings(settings)
    require(len(old.free) >= 2, "Need two erased NVS pages (one retained as GC reserve); no compaction")
    namespace = old.namespaces.get(NAMESPACE)
    if namespace is None:
        namespace = next((i for i in range(1, 255) if i not in old.namespaces.values()), None)
        require(namespace is not None, "No namespace index available")
    active = old.selected(ACTIVE_KEY)
    slot = 1 - active if active is not None else 0
    target = SLOT_KEYS[slot]
    existing = old.find(namespace, target)
    require(all(r.kind in (0x41, 0x42, 0x48) for r in existing), "Unsupported profile slot type")
    if existing:
        old.blob(namespace, target)
    sequence = max((p[0] for p in old.pages), default=-1) + 1
    page = bytearray(b"\xff" * PAGE)
    struct.pack_into("<II", page, 0, 0xFFFFFFFE, sequence)
    page[8] = 0xFE
    struct.pack_into("<I", page, 28, crc(page[4:28]))
    index = 0
    if NAMESPACE not in old.namespaces:
        index = append_record(page, index, make_entry(0, 1, NAMESPACE, bytes((namespace,))))
    span = 1 + (len(blob) + 31) // 32
    index = append_record(page, index, make_entry(namespace, 0x42, target,
                          struct.pack("<H", len(blob)) + b"\xff\xff" + struct.pack("<I", crc(blob)),
                          span, 0), blob)
    index = append_record(page, index, make_entry(namespace, 0x48, target,
                          struct.pack("<IBB", len(blob), 1, 0)))
    phase1 = bytearray(image)
    erase_records(phase1, existing)
    for _, offset, state in old.pages:
        if state == 0xFFFFFFFE:
            struct.pack_into("<I", phase1, offset, 0xFFFFFFFC)
    offset = old.free[0]
    phase1[offset:offset + PAGE] = page
    RawNVS(bytes(phase1))
    append_record(page, index, make_entry(namespace, 1, ACTIVE_KEY, bytes((slot,))))
    phase2 = bytearray(phase1)
    erase_records(phase2, old.find(namespace, ACTIVE_KEY))
    phase2[offset:offset + PAGE] = page
    require(RawNVS(bytes(phase2)).settings() == settings, "NVS plan verification failed")
    return bytes(phase1), bytes(phase2)


def parse_ssid(value):
    require(isinstance(value, dict) and ("ssid" in value) != ("ssid_hex" in value),
            "Specify exactly one of ssid or ssid_hex")
    if "ssid" in value:
        require(isinstance(value["ssid"], str), "SSID must be a string")
        ssid = value["ssid"].encode("utf-8")
    else:
        require(isinstance(value["ssid_hex"], str) and
                re.fullmatch(r"(?:[0-9a-fA-F]{2}){1,32}", value["ssid_hex"]) is not None,
                "Invalid ssid_hex")
        ssid = bytes.fromhex(value["ssid_hex"])
    require(1 <= len(ssid) <= 32 and b"\0" not in ssid, "Invalid SSID")
    return ssid


def profile_input(value):
    require(isinstance(value, dict) and set(value) <= {"ssid", "ssid_hex", "password"},
            "Unexpected profile fields")
    require(isinstance(value.get("password"), str), "A password string is required")
    require(value["password"].isascii(), "Invalid WPA2 password")
    profile = Profile(parse_ssid(value), value["password"].encode("ascii"))
    validate_profile(profile)
    return profile


def modify(settings, operation, selector=None, payload=None, hostname=None, station=None):
    profiles = list(settings.profiles)
    matching = [i for i, profile in enumerate(profiles) if profile.ssid == selector]
    if operation == "add":
        profile = profile_input(payload)
        require(not any(p.ssid == profile.ssid for p in profiles), "SSID already exists; use update")
        profiles.append(profile)
    elif operation == "update":
        require(len(matching) == 1, "SSID not found")
        require(isinstance(payload, dict) and bool(payload) and
                set(payload) <= {"ssid", "ssid_hex", "password"}, "Invalid update fields")
        previous = profiles[matching[0]]
        ssid = parse_ssid(payload) if "ssid" in payload or "ssid_hex" in payload else previous.ssid
        password = payload.get("password")
        if password is None:
            require("password" not in payload, "Password cannot be null")
            password = previous.password.decode("ascii")
        profile = profile_input({"ssid_hex": ssid.hex(), "password": password})
        if profile.ssid == previous.ssid and profile.password == previous.password:
            profile = previous
        if profile == previous:
            profiles[matching[0]] = previous
        else:
            del profiles[matching[0]]
            profiles.append(profile)
    elif operation == "delete":
        require(len(matching) == 1, "SSID not found")
        del profiles[matching[0]]
    elif operation == "import":
        require(isinstance(payload, list) and bool(payload), "Import must be a nonempty profile array")
        incoming = [profile_input(item) for item in payload]
        require(len({p.ssid for p in incoming}) == len(incoming), "Duplicate SSID in import")
        for profile in incoming:
            found = next((p for p in profiles if p.ssid == profile.ssid), None)
            if found and found.password == profile.password:
                continue
            profiles = [p for p in profiles if p.ssid != profile.ssid]
            profiles.append(profile)
    else:
        raise ValueError("Unknown mutation")
    result = Settings(settings.station, settings.hostname, tuple(profiles))
    if not settings.profiles and profiles:
        result = replace(result, station=True)
    if hostname is not None:
        result = replace(result, hostname=hostname.encode("utf-8"))
    if station is not None:
        result = replace(result, station=bool(station))
    if not profiles:
        result = replace(result, station=False)
    encode_settings(result)
    return result


def redacted(settings):
    return {"station": settings.station,
            "hostname": settings.hostname.decode("utf-8", errors="backslashreplace"),
            "profiles": [{"ssid_hex": p.ssid.hex(),
                          "ssid": p.ssid.decode("utf-8", errors="backslashreplace"),
                          "password": "[redacted]", "verified": p.verified}
                         for p in settings.profiles]}


def read_credentials(filename):
    path = Path(filename)
    require(not path.is_symlink(), "Credential file must not be a symlink")
    require(not path.resolve().is_relative_to(Path(__file__).resolve().parents[1]),
            "Credential file must be outside the repository")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "r", encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode), "Credentials must be a regular file")
        require(os.name != "nt", "Private credential-file validation currently requires POSIX; use prompt")
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                "Credential file must be owned by you and mode 0600 (or stricter)")
        try:
            return json.load(source, object_pairs_hook=unique_fields)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Invalid credential JSON (contents suppressed)") from None


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field")
        result[key] = value
    return result


def inspect_partition(table_data, sdk, flash_bytes, table_offset):
    require(len(table_data) == PAGE and table_offset >= PAGE and table_offset % PAGE == 0,
            "Invalid partition-table address")
    sdk.partitions.offset_part_table = table_offset
    table = sdk.partitions.PartitionTable.from_binary(table_data)
    table.verify()
    table.verify_size_fits(flash_bytes)
    require(not any(p.encrypted for p in table), "Encrypted partitions are unsupported")
    nvs = table.find_by_name("nvs")
    require(nvs is not None and nvs.type == 1 and nvs.subtype == 2 and
            not nvs.readonly and nvs.offset % PAGE == 0 and
            nvs.size >= 3 * PAGE and nvs.size % PAGE == 0, "Writable default NVS required")
    require(nvs.offset >= table_offset + PAGE and nvs.offset + nvs.size <= flash_bytes,
            "NVS overlaps partition table or exceeds flash")
    return nvs


def transact(arguments, sdk, payload=None):
    mutation = arguments.operation != "list"
    require(re.fullmatch(r"[0-9a-f]{12}", arguments.device_id) is not None,
            "--device-id must be 12 lowercase hex digits (factory base MAC)")
    require(bool(arguments.port), "Explicit --port required")
    if mutation:
        require(arguments.execute and arguments.allow_nvs_rewrite,
                "Mutations require --execute AND --allow-nvs-rewrite; read the power-loss warning")
        require(arguments.backup_dir is not None, "--backup-dir is required for writes")
    directory = None
    with sdk.esptool.detect_chip(port=arguments.port) as connection:
        device = connection
        try:
            require(connection.CHIP_NAME == "ESP32-S3" and
                    connection.secure_download_mode is False, "Normal ESP32-S3 ROM mode required")
            secure = connection.get_secure_boot_enabled()
            require(type(secure) in (bool, int) and secure == 0 and
                    connection.get_flash_encryption_enabled() is False,
                    "Secure boot / encrypted flash is unsupported")
            require(bytes(connection.read_mac(mac_type="BASE_MAC")).hex() == arguments.device_id,
                    "Device MAC mismatch")
            device = sdk.esptool.run_stub(connection)
            sdk.esptool.attach_flash(device)
            flash_bytes = flash_capacity(sdk.esptool.detect_flash_size(device))

            def read(offset, size):
                data = sdk.esptool.read_flash(device, offset, size, no_progress=True)
                require(isinstance(data, bytes) and len(data) == size, "Incomplete flash read")
                return data

            table_data = read(arguments.partition_table_offset, PAGE)
            partition = inspect_partition(table_data, sdk, flash_bytes, arguments.partition_table_offset)
            original = read(partition.offset, partition.size)
            old = RawNVS(original).settings()
            if not mutation:
                return redacted(old)
            updated = modify(old, arguments.operation, arguments.selector, payload,
                             arguments.hostname, arguments.station)
            phases = plan_update(original, updated)
            directory = create_private_directory(arguments.backup_dir)
            private_write(directory, "nvs-backup.bin", original)
            digest = hashlib.sha256(original).hexdigest()
            require((directory / "nvs-backup.bin").read_bytes() == original,
                    "Private backup verification failed")
            private_write(directory, "nvs-backup.json", (json.dumps({
                "device_id": arguments.device_id, "offset": partition.offset,
                "size": partition.size, "sha256": digest,
                "partition_table_sha256": hashlib.sha256(table_data).hexdigest(),
                "created": datetime.now(timezone.utc).isoformat(),
                "warning": "NVS sector rewrites are NOT power-loss atomic",
            }, indent=2) + "\n").encode())
            require(read(arguments.partition_table_offset, PAGE) == table_data and
                    read(partition.offset, partition.size) == original,
                    "Flash changed after planning; refusing write")
            for phase in phases:
                sdk.esptool.write_flash(device, [(partition.offset, phase)], erase_all=False,
                                        force=False, no_progress=True)
                require(read(partition.offset, partition.size) == phase, "NVS readback mismatch; keep backup")
            require(read(arguments.partition_table_offset, PAGE) == table_data,
                    "Partition table changed")
            return {"verified": True, "backup": str(directory), **redacted(updated)}
        finally:
            sdk.esptool.reset_chip(device, "hard-reset")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        "WARNING: writes erase/rewrite NVS sectors. Power loss can destroy identity/ownership "
        "and both profile slots. A private verified backup and --allow-nvs-rewrite are mandatory."))
    parser.add_argument("operation", choices=("list", "add", "update", "delete", "import"))
    parser.add_argument("--port", required=True)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--idf-path", default=os.environ.get("IDF_PATH"))
    parser.add_argument("--partition-table-offset", type=lambda value: int(value, 0), default=0x8000)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--allow-nvs-rewrite", action="store_true")
    parser.add_argument("--backup-dir")
    parser.add_argument("--credentials", help="Private outside-repository JSON file; never CLI passwords")
    selector = parser.add_mutually_exclusive_group()
    selector.add_argument("--ssid")
    selector.add_argument("--ssid-hex")
    parser.add_argument("--hostname")
    parser.add_argument("--station", choices=(0, 1), type=int)
    arguments = parser.parse_args(argv)
    arguments.selector = None
    if arguments.ssid is not None or arguments.ssid_hex is not None:
        arguments.selector = parse_ssid({"ssid": arguments.ssid} if arguments.ssid is not None
                                       else {"ssid_hex": arguments.ssid_hex})
    require(arguments.idf_path is not None, "Activate ESP-IDF or specify --idf-path")
    if arguments.operation in ("update", "delete"):
        require(arguments.selector is not None, "An SSID selector is required")
    else:
        require(arguments.selector is None or arguments.operation == "add", "Unexpected SSID selector")
    require(arguments.operation not in ("list", "delete") or arguments.credentials is None,
            "Credentials are not used for this operation")
    require(arguments.operation != "list" or
            (arguments.hostname is None and arguments.station is None), "list cannot change settings")
    if arguments.operation != "list":
        require(arguments.execute and arguments.allow_nvs_rewrite and arguments.backup_dir,
                "Mutations require --execute, --allow-nvs-rewrite and --backup-dir before connecting")
    payload = None
    if arguments.credentials:
        payload = read_credentials(arguments.credentials)
    elif arguments.operation in ("add", "update"):
        require(sys.stdin.isatty(), "Password prompting requires a terminal; use a private JSON file")
        if arguments.operation == "add":
            require(arguments.selector is not None, "Prompted add requires --ssid or --ssid-hex")
            payload = {"ssid_hex": arguments.selector.hex(),
                       "password": getpass.getpass("WPA2 password (8-63 printable ASCII): ")}
        else:
            password = getpass.getpass("New WPA2 password (blank preserves current): ")
            payload = {"password": password} if password else {}
            require(payload or arguments.hostname is not None or arguments.station is not None,
                    "No update requested")
            if not payload:
                payload = {"ssid_hex": arguments.selector.hex()}
    elif arguments.operation == "import":
        raise ValueError("Batch import requires --credentials JSON array")
    with contextlib.redirect_stdout(sys.stderr):
        sdk = load_sdk(arguments.idf_path)
        try:
            result = transact(arguments, sdk, payload)
        except sdk.esptool.FatalError:
            raise ToolError("Serial/flash operation failed; keep the backup and inspect the device "
                            "before retrying. Reset was attempted if a connection was established.") from None
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except ToolError as error:
        print(f"USB NVS tool stopped: {error}", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, ImportError) as error:
        # Library and filesystem messages can contain user input; never echo them.
        print(f"USB NVS tool stopped ({type(error).__name__}); no credential details logged. "
              "Check permissions, supported NVS layout, device ID and required safety flags.",
              file=sys.stderr)
        sys.exit(1)
