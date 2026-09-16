import argparse
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import zipfile

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
import espsecure


FLASH_BYTES = 0x1000000
SLOT_BYTES = 0x600000
IMAGE_LIMIT = 0x4CC000
DESCRIPTOR_OFFSET = 0x120
SECURITY = {"secureBoot": False, "flashEncryption": False, "signedApps": True,
            "antiRollback": False, "httpDevelopment": True}
LAYOUT = [("nvs", 1, 2, 0x9000, 0x10000), ("otadata", 1, 0, 0x19000, 0x2000),
          ("phy_init", 1, 1, 0x1B000, 0x1000), ("ota_0", 0, 16, 0x20000, SLOT_BYTES),
          ("ota_1", 0, 17, 0x620000, SLOT_BYTES)]
ROLES = {"bootloader": 0, "partition-table": 0x8000, "otadata": 0x19000, "app": 0x20000}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def image_bytes(image):
    data = Path(image["source"]).read_bytes()
    require(len(data) == image["bytes"] and hashlib.sha256(data).hexdigest() == image["sha256"],
            "Firmware file changed after validation")
    return data


def public_key(key_data):
    try:
        key = serialization.load_pem_public_key(key_data)
    except ValueError:
        private = serialization.load_pem_private_key(key_data, password=None)
        require(isinstance(private, rsa.RSAPrivateKey), "RSA-3072 signing key required")
        key = private.public_key()
    require(isinstance(key, rsa.RSAPublicKey) and key.key_size == 3072, "RSA-3072 verification key required")
    return key


def key_fingerprint(key):
    encoded = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(encoded).hexdigest()


def version_valid(value):
    if not isinstance(value, str) or re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value) is None:
        return False
    return all(int(part) <= 65535 for part in value.split("."))


def parse_descriptor(data):
    require(len(data) >= DESCRIPTOR_OFFSET + 256 and data[0] == 0xE9, "Missing ESP application descriptor")
    fields = struct.unpack_from("<8s8I32s32s32s48s32s40s", data, DESCRIPTOR_OFFSET)
    require(fields[0] == b"KBOTA001" and fields[1:8] == (1, 1, 1, 1, 10, FLASH_BYTES, SLOT_BYTES) and
            fields[8] in (1, 2) and fields[14] == bytes(40), "Incompatible OTA descriptor")

    def text(value):
        require(b"\0" in value, "Unterminated descriptor string")
        value = value.split(b"\0", 1)[0]
        require(value and all(0x21 <= character <= 0x7E for character in value), "Invalid descriptor string")
        return value.decode("ascii")

    product, board, layout, source, version = map(text, fields[9:14])
    require(product == "remote-keyboard" and board in ("esp32s3-generic-16m", "xinlucity-s3-nano-16m") and
            layout == "kb16-ab6-nvs64-v1" and re.fullmatch(r"[0-9a-f]{40}", source) and version_valid(version),
            "Invalid OTA product, board, layout, source, or version")
    require(struct.unpack_from("<I", data, 32)[0] == 0xABCD5432 and text(data[48:80]) == version,
            "ESP application version differs from signed compatibility metadata")
    return {"product": product, "board": board, "layout": layout, "source": source, "version": version,
            "bootstrapVersion": 1, "updaterVersion": 1, "settingsVersion": 1, "kdfIterations": 10,
            "testOnly": fields[8] == 1, "idfVersion": text(data[144:176])}


def verify_application(data, key):
    require(8192 <= len(data) <= IMAGE_LIMIT and len(data) % 4096 == 0,
            "Signed application exceeds its budget or is not sector aligned")
    require(data[-4096 + espsecure.SIG_BLOCK_SIZE:] == b"\xff" * (4096 - espsecure.SIG_BLOCK_SIZE),
            "Exactly one signature block is required")
    encoded = key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    with contextlib.redirect_stdout(sys.stderr):
        espsecure.verify_signature_v2(hsm=False, hsm_config=None,
                          keyfile=io.BytesIO(encoded), datafile=io.BytesIO(data))
    return parse_descriptor(data)


def inspect_ota_firmware(firmware, sdk, key):
    require(firmware.get("security") == SECURITY and firmware.get("flashBytes") == FLASH_BYTES,
            "Unsupported OTA security or capacity profile")
    require(firmware.get("settings") == {"flash_mode": "dio", "flash_freq": "80m", "flash_size": "keep"},
            "Signed OTA images require DIO/80MHz with unchanged flash headers")
    images = {image["role"]: image for image in firmware["images"]}
    require(len(firmware["images"]) == 4 and set(images) == set(ROLES), "Expected four OTA install image roles")
    for role, offset in ROLES.items():
        require(images[role]["offset"] == offset, "Incorrect OTA install offset")
    sdk.partitions.offset_part_table = 0x8000
    table = sdk.partitions.PartitionTable.from_binary(image_bytes(images["partition-table"]))
    table.verify()
    table.verify_size_fits(FLASH_BYTES)
    require([(part.name, part.type, part.subtype, part.offset, part.size) for part in table] == LAYOUT and
            not any(part.encrypted or part.readonly for part in table), "Unexpected OTA partition layout")
    require(image_bytes(images["otadata"]) == b"\xff" * 8192, "Initial OTA data must be erased for ota_0 boot")
    previous_end = 0
    for image in sorted(images.values(), key=lambda value: value["offset"]):
        data = image_bytes(image)
        end = image["offset"] + (len(data) + 4095) // 4096 * 4096
        require(data and image["offset"] >= previous_end and end <= FLASH_BYTES, "Overlapping OTA install images")
        if image["role"] == "bootloader":
            require(end <= 0x8000, "Bootloader overlaps partition table")
        if image["role"] == "partition-table":
            require(end <= 0x9000, "Partition table overlaps NVS")
        previous_end = end
    for role in ("bootloader", "app"):
        image = sdk.images.LoadFirmwareImage("esp32s3", image_bytes(images[role]))
        require(image.chip_id == image.ROM_LOADER.IMAGE_CHIP_ID and image.checksum == image.calculate_checksum() and
                image.append_digest and image.stored_digest == image.calc_digest,
                "Invalid ESP32-S3 image checksum or digest")
        require(image.flash_mode == 2 and image.flash_size_freq == 0x4F, "Incorrect embedded flash settings")
    descriptor = verify_application(image_bytes(images["app"]), key)
    return {"nvs": {"offset": 0x9000, "size": 0x10000}, "partitionTable": {"offset": 0x8000, "size": 4096},
            "settings": firmware["settings"], "flashBytes": FLASH_BYTES, "descriptor": descriptor,
            "verifiedSigningKeySha256": key_fingerprint(key)}


def verify_manifest(firmware, key):
    manifest = firmware["manifest"]
    require(manifest.get("formatVersion") == 3 and manifest.get("artifact") == "keyboard-install" and
            manifest.get("target") == "esp32s3" and manifest.get("signingKeySha256") == key_fingerprint(key), "Untrusted install manifest key or schema")
    try:
        key.verify(bytes.fromhex(firmware["manifestSignature"]), canonical_json(manifest),
                   padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    except (InvalidSignature, ValueError) as error:
        raise ValueError("Install manifest signature verification failed") from error
    actual_images = [{field: image[field] for field in ("role", "path", "offset", "bytes", "sha256")}
                     for image in firmware["images"]]
    require(manifest.get("images") == actual_images and manifest.get("settings") == firmware["settings"] and
            manifest.get("security") == firmware["security"] and manifest.get("flashBytes") == FLASH_BYTES,
            "Authenticated manifest differs from install images")


def build_artifacts(build, sdk, project):
    build = Path(build).resolve()
    project = Path(project).resolve()
    configuration = json.loads((build / "config/sdkconfig.json").read_text())
    required = ("SECURE_SIGNED_APPS_NO_SECURE_BOOT", "SECURE_SIGNED_APPS_RSA_SCHEME",
                "SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT", "SECURE_BOOT_BUILD_SIGNED_BINARIES",
                "BOOTLOADER_APP_ROLLBACK_ENABLE", "BOOTLOADER_WDT_ENABLE", "BOOTLOADER_WDT_DISABLE_IN_USER_CODE",
                "ESP_PHY_CALIBRATION_AND_DATA_STORAGE", "KEYBOARD_HTTP_DEVELOPMENT")
    require(all(configuration.get(name) is True for name in required), "Missing required OTA build verification settings")
    forbidden = ("SECURE_BOOT", "SECURE_FLASH_ENC_ENABLED", "BOOTLOADER_APP_ANTI_ROLLBACK", "ESP_PHY_INIT_DATA_IN_PARTITION")
    require(not any(configuration.get(name) for name in forbidden) and configuration.get("ESPTOOLPY_FLASHSIZE") == "16MB",
            "Unsupported OTA hardware security, PHY, or flash profile")
    key_path = (project / configuration["SECURE_BOOT_SIGNING_KEY"]).resolve()
    private = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    require(isinstance(private, rsa.RSAPrivateKey) and private.key_size == 3072, "RSA-3072 signing key required")
    key = private.public_key()
    release = configuration.get("KEYBOARD_RELEASE") is True
    if release:
        require(not key_path.is_relative_to(project), "Release signing key must be outside the repository")
        require(subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=project, check=False).returncode == 0,
                "Release builds require a clean tracked worktree")
    flash = json.loads((build / "flasher_args.json").read_text())
    require(flash["extra_esptool_args"]["chip"] == "esp32s3" and len(flash["flash_files"]) == 4,
            "Unexpected flash manifest")
    images = []
    for role, offset in ROLES.items():
        item = flash[role]
        relative = Path(item["file"])
        source = (build / relative).resolve()
        require(not relative.is_absolute() and source.is_relative_to(build) and ".." not in relative.parts and
                item["encrypted"] == "false" and int(item["offset"], 16) == offset and
                flash["flash_files"][item["offset"]] == item["file"], "Unsafe flash image")
        data = source.read_bytes()
        images.append({"role": role, "offset": offset, "path": relative.as_posix(), "source": str(source),
                       "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    firmware = {"security": SECURITY, "flashBytes": FLASH_BYTES, "settings": flash["flash_settings"], "images": images}
    plan = inspect_ota_firmware(firmware, sdk, key)
    require(plan["descriptor"]["testOnly"] is not release, "Descriptor security profile differs from build")
    manifest = {"formatVersion": 3, "artifact": "keyboard-install", "target": "esp32s3", "security": SECURITY,
                "settings": firmware["settings"], "flashBytes": FLASH_BYTES, "descriptor": plan["descriptor"],
                "signingKeySha256": key_fingerprint(key),
                "images": [{field: item[field] for field in ("role", "path", "offset", "bytes", "sha256")} for item in images]}
    signature = private.sign(canonical_json(manifest), padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    (build / "firmware-manifest.json").write_bytes(canonical_json(manifest))
    (build / "firmware-manifest.sig").write_bytes(signature)
    firmware.update(manifest=manifest, manifestSignature=signature.hex())
    verify_manifest(firmware, key)
    app = next(item for item in images if item["role"] == "app")
    ota = image_bytes(app)
    (build / "firmware-ota.bin").write_bytes(ota)
    ota_manifest = {"formatVersion": 1, "artifact": "keyboard-ota", "descriptor": plan["descriptor"],
                    "bytes": len(ota), "sha256": app["sha256"], "signingKeySha256": key_fingerprint(key)}
    (build / "firmware-ota.json").write_bytes(canonical_json(ota_manifest))
    (build / "firmware-signing-public.pem").write_bytes(key.public_bytes(serialization.Encoding.PEM,
                                                                      serialization.PublicFormat.SubjectPublicKeyInfo))
    archive_path = build / "firmware-install.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in [item["path"] for item in images] + ["flasher_args.json", "firmware-manifest.json", "firmware-manifest.sig"]:
            archive.write(build / name, name)
    with zipfile.ZipFile(archive_path) as archive:
        require(archive.testzip() is None and archive.read(app["path"]) == ota, "Wired and OTA applications differ")
        for item in images:
            require(hashlib.sha256(archive.read(item["path"])).hexdigest() == item["sha256"], "Archive image hash mismatch")
    for name in ("firmware-install.zip", "firmware-ota.bin"):
        digest = hashlib.sha256((build / name).read_bytes()).hexdigest()
        (build / f"{name}.sha256").write_text(f"{digest}  {name}\n", encoding="ascii")
    print(f"OTA artifacts: {plan['descriptor']['version']}, {len(ota)} signed bytes, "
          f"{'TEST ONLY' if not release else 'release'}, identical wired/OTA application.")
    return firmware


if __name__ == "__main__":
    from install_device import load_sdk

    parser = argparse.ArgumentParser()
    parser.add_argument("--build", required=True)
    parser.add_argument("--idf-path", required=True)
    arguments = parser.parse_args()
    build_artifacts(arguments.build, load_sdk(arguments.idf_path), Path(__file__).resolve().parents[1])