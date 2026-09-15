import argparse
import contextlib
import csv
from datetime import datetime, timezone
import hashlib
import importlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from types import SimpleNamespace


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_sdk(idf_path):
    parser_path = Path(idf_path) / "components/partition_table/gen_esp32part.py"
    require(parser_path.is_file(), "Set IDF_PATH or --idf-path to the ESP-IDF SDK")
    specification = importlib.util.spec_from_file_location("keyboard_partitions", parser_path)
    if specification is None or specification.loader is None:
        raise ValueError("Cannot load ESP-IDF partition parser")
    partitions = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(partitions)
    esptool = importlib.import_module("esptool")
    require(esptool.__version__ in ("5.3.1", "5.4.0"),
            f"Use validated esptool 5.3.1 or 5.4.0 (found {esptool.__version__})")
    return SimpleNamespace(partitions=partitions, esptool=esptool,
                           images=importlib.import_module("esptool.bin_image"))


def image_bytes(image):
    data = Path(image["source"]).read_bytes()
    require(len(data) == image["bytes"] and hashlib.sha256(data).hexdigest() == image["sha256"],
            "Firmware file changed after validation")
    return data


def inspect_firmware(firmware, sdk):
    require(firmware.get("security") == {"secureBoot": False, "flashEncryption": False,
                                        "signedApps": False, "antiRollback": False, "httpDevelopment": True} and
            firmware["security"]["httpDevelopment"] is True,
            "A validated firmware build without security provisioning and with the HTTP owner-claim UI is required")
    images = {image["role"]: image for image in firmware["images"]}
    require(len(firmware["images"]) == 3 and set(images) == {"bootloader", "partition-table", "app"},
            "Expected exactly three firmware images")
    partition_image = images["partition-table"]
    partition_data = image_bytes(partition_image)
    require(0 < len(partition_data) <= sdk.partitions.MAX_PARTITION_LENGTH, "Unsupported partition-table image size")
    sdk.partitions.offset_part_table = partition_image["offset"]
    table = sdk.partitions.PartitionTable.from_binary(partition_data)
    table.verify()
    table.verify_size_fits(firmware["flashBytes"])
    require(not any(partition.encrypted for partition in table), "Encrypted partitions need a separate installer")
    nvs = table.find_by_name("nvs")
    if nvs is None or nvs.type != 1 or nvs.subtype != 2 or nvs.readonly:
        raise ValueError("A writable default nvs partition is required")
    require(nvs.size >= 0x3000 and nvs.size % 4096 == 0, "Unsupported NVS partition size")
    applications = [partition for partition in table if partition.type == 0]
    require(len(applications) == 1 and applications[0].subtype == 0 and
            not any(partition.type == 1 and partition.subtype == 0 for partition in table),
            "Only a single factory application without OTA metadata is supported")
    application = applications[0]
    application_write_size = ((images["app"]["bytes"] + 4095) // 4096) * 4096
    require(images["app"]["offset"] == application.offset and application_write_size <= application.size,
            "Application does not fit its declared partition")
    require(images["bootloader"]["offset"] == 0, "ESP32-S3 bootloader must start at zero")
    for role in ("bootloader", "app"):
        image = sdk.images.LoadFirmwareImage("esp32s3", image_bytes(images[role]))
        require(image.chip_id == image.ROM_LOADER.IMAGE_CHIP_ID, "Firmware header targets another chip")
        require(image.checksum == image.calculate_checksum(), "Firmware checksum mismatch")
        require(image.append_digest and image.stored_digest == image.calc_digest,
                "Firmware SHA-256 digest is missing or invalid")
    ranges = [(image["offset"], image["bytes"]) for image in images.values()] + [(nvs.offset, nvs.size)]
    previous_end = 0
    for offset, size in sorted(ranges):
        require(offset >= previous_end and offset % 4096 == 0 and size > 0, "Overlapping or unaligned flash writes")
        previous_end = offset + ((size + 4095) // 4096) * 4096
        require(previous_end <= firmware["flashBytes"], "Flash write exceeds configured capacity")
    return {"nvs": {"offset": nvs.offset, "size": nvs.size},
            "partitionTable": {"offset": partition_image["offset"], "size": 4096},
            "settings": firmware["settings"], "flashBytes": firmware["flashBytes"]}


def sync_directory(directory):
    if sys.platform == "win32":
        return
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def create_private_directory(output):
    directory = Path(output).absolute()
    repository = Path(__file__).resolve().parents[1]
    require(not directory.is_relative_to(repository), "Private installation files must be outside the repository")
    parent = directory.parent.resolve(strict=True)
    require(not parent.is_relative_to(repository), "Private output must not resolve into the repository")
    directory = parent / directory.name
    directory.mkdir(mode=0o700)
    if sys.platform == "win32":
        domain = os.environ.get("USERDOMAIN")
        username = os.environ.get("USERNAME")
        require(domain and username, "Cannot identify the Windows account for private permissions")
        permissions = subprocess.run(
            ["icacls.exe", str(directory), "/inheritance:r", "/grant:r", f"{domain}\\{username}:(OI)(CI)F"],
            capture_output=True, check=False)
        require(permissions.returncode == 0, "Cannot restrict Windows installation directory permissions")
    else:
        permissions = directory.stat()
        require(permissions.st_uid == os.getuid() and permissions.st_mode & 0o077 == 0,
                "Installation directory is not private")
    for ancestor in directory.parents:
        sync_directory(ancestor)
    return directory


def private_write(directory, name, data):
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    sync_directory(directory)


def validate_identity(contents, device_id):
    rows = list(csv.DictReader(io.StringIO(contents)))
    expected = [
        ("kb_identity", "namespace", "", ""),
        ("version", "data", "u32", "1"),
        ("device_id", "data", "string", re.escape(device_id)),
        ("ap_password", "data", "string", r"[A-Za-z0-9_-]{24}"),
        ("claim_salt", "data", "hex2bin", r"[0-9a-f]{32}"),
        ("claim_hash", "data", "hex2bin", r"[0-9a-f]{64}"),
        ("claim_cost", "data", "u32", "100000"),
    ]
    require(len(rows) == len(expected), "Unexpected identity CSV records")
    for row, (key, kind, encoding, pattern) in zip(rows, expected):
        require(set(row) == {"key", "type", "encoding", "value"} and row["key"] == key and
                row["type"] == kind and row["encoding"] == encoding and
                isinstance(row["value"], str) and re.fullmatch(pattern, row["value"]) is not None,
                f"Invalid identity CSV field: {key}")


def generate_nvs(directory, device_id, size):
    source = directory / "identity.csv"
    target = directory / "identity.bin"
    validate_identity(source.read_text(encoding="utf-8"), device_id)
    require(not target.exists(), "Private NVS image already exists; do not regenerate an installation in place")
    generated = subprocess.run(
        [sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate", str(source), str(target),
         hex(size), "--version", "2", "--outdir", str(directory)],
        capture_output=True, check=False)
    require(generated.returncode == 0, "ESP-IDF NVS generation failed; check the SDK environment and private CSV")
    target.chmod(0o600)
    with target.open("r+b") as generated_image:
        data = generated_image.read()
        require(len(data) == size, "NVS generator produced an unexpected image size")
        os.fsync(generated_image.fileno())
    sync_directory(directory)
    return data


def flash_capacity(value):
    require(isinstance(value, str) and re.fullmatch(r"(1|2|4|8|16|32)MB", value) is not None,
            "Unknown or unsupported flash capacity; refusing to guess")
    return int(value[:-2]) * 1048576


def install(request, sdk):
    require(request.get("execute") is True, "A device write requires --execute")
    device_id = request["deviceId"]
    require(isinstance(device_id, str) and re.fullmatch(r"[0-9a-f]{12}", device_id) is not None,
            "An expected factory base MAC is required")
    require(isinstance(request["port"], str) and request["port"] and "://" not in request["port"],
            "An explicit local serial port is required")
    require(request["baud"] in (115200, 230400, 460800, 921600), "Unsupported serial baud rate")
    identity_csv = request["identityCsv"]
    require(isinstance(identity_csv, str), "A MAC-bound identity CSV is required")
    validate_identity(identity_csv, device_id)
    firmware = request["firmware"]
    plan = inspect_firmware(firmware, sdk)
    require(flash_capacity(plan["settings"]["flash_size"]) == plan["flashBytes"], "Inconsistent flash capacity")
    directory = create_private_directory(request["directory"])
    private_write(directory, "identity.csv", identity_csv.encode("utf-8"))
    nvs_data = generate_nvs(directory, device_id, plan["nvs"]["size"])
    payloads = [(image["offset"], image_bytes(image)) for image in firmware["images"]]
    payloads.append((plan["nvs"]["offset"], nvs_data))
    payloads.sort(key=lambda item: item[0])
    manifest = {"formatVersion": 1, "deviceId": device_id, "createdAt": datetime.now(timezone.utc).isoformat(),
                "layout": plan, "replaceNvs": request.get("replaceNvs") is True,
                "images": [{"offset": offset, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                           for offset, data in payloads]}
    private_write(directory, "install-plan.json", (json.dumps(manifest, indent=2) + "\n").encode())
    backup_durability = "file-and-directory-sync"
    if sys.platform == "win32":
        backup_durability = "file-sync-only"
        print("Windows backups are verified but not guaranteed durable across host power loss; "
              "keep the host and backup storage powered.", file=sys.stderr)
    with sdk.esptool.detect_chip(port=request["port"]) as connection:
        require(connection.CHIP_NAME == "ESP32-S3", "Connected board is not an ESP32-S3")
        require(connection.secure_download_mode is False,
            "Secure download mode requires a separate installation workflow")
        secure_boot_enabled = connection.get_secure_boot_enabled()
        require(type(secure_boot_enabled) in (bool, int) and secure_boot_enabled == 0 and
            connection.get_flash_encryption_enabled() is False,
            "Secure boot or flash encryption requires a separate installation workflow")
        require(bytes(connection.read_mac(mac_type="BASE_MAC")).hex() == device_id,
            "Connected board factory base MAC does not match --device-id")
        device = sdk.esptool.run_stub(connection)
        device.change_baud(request["baud"])
        sdk.esptool.attach_flash(device)
        detected_size = sdk.esptool.detect_flash_size(device)
        detected_bytes = flash_capacity(detected_size)
        require(detected_bytes >= plan["flashBytes"], "Board flash is smaller than the firmware configuration")
        backup = sdk.esptool.read_flash(device, 0, detected_bytes, no_progress=True)
        require(isinstance(backup, bytes) and len(backup) == detected_bytes, "Incomplete flash backup")
        require(device.flash_md5sum(0, detected_bytes) == hashlib.md5(backup).hexdigest(), "Flash backup verification failed")
        private_write(directory, "flash-backup.bin", backup)
        backup_hash = hashlib.sha256(backup).hexdigest()
        require(hashlib.sha256((directory / "flash-backup.bin").read_bytes()).hexdigest() == backup_hash,
            "Saved flash backup verification failed")
        private_write(directory, "flash-backup.json", (json.dumps({"deviceId": device_id, "bytes": detected_bytes,
                  "sha256": backup_hash, "offset": 0, "durability": backup_durability}, indent=2) + "\n").encode())
        table_image = next(image for image in firmware["images"] if image["role"] == "partition-table")
        table_offset = plan["partitionTable"]["offset"]
        existing_table = backup[table_offset:table_offset + 4096]
        expected_table = image_bytes(table_image).ljust(4096, b"\xff")
        require(backup == b"\xff" * detected_bytes or existing_table == expected_table,
            "Existing partition table differs; automatic partition migration is not supported")
        nvs_offset = plan["nvs"]["offset"]
        existing_nvs = backup[nvs_offset:nvs_offset + plan["nvs"]["size"]]
        require(existing_nvs == b"\xff" * len(existing_nvs) or request.get("replaceNvs") is True,
            "NVS is not empty; --replace-nvs explicitly discards its settings and any existing ownership")
        sdk.esptool.write_flash(device, payloads, **plan["settings"], erase_all=False, force=False, no_progress=True)
        sdk.esptool.verify_flash(device, payloads, **plan["settings"])
        result = {"deviceId": device_id, "verified": True, "flashBytes": detected_bytes,
              "backupSha256": backup_hash, "backupDurability": backup_durability, "images": manifest["images"]}
        try:
            private_write(directory, "install-result.json", (json.dumps(result, indent=2) + "\n").encode())
        finally:
            sdk.esptool.reset_chip(device, "hard-reset")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["inspect", "install"])
    arguments = parser.parse_args()
    request = json.load(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        sdk = load_sdk(request["idfPath"])
        if arguments.operation == "inspect":
            result = inspect_firmware(request["firmware"], sdk)
        else:
            result = install(request, sdk)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Installer stopped: {error}", file=sys.stderr)
        sys.exit(1)