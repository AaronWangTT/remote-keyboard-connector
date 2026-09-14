import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from install_device import generate_nvs, inspect_firmware, install, load_sdk, validate_identity


class FakeDevice:
    CHIP_NAME = "ESP32-S3"
    secure_download_mode = False
    secure_boot = False
    encryption = False
    device_id = "001122334455"
    backup_valid = True

    def __init__(self, flash):
        self.flash = bytearray(flash)
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        self.closed = True

    def get_secure_boot_enabled(self):
        return self.secure_boot

    def get_flash_encryption_enabled(self):
        return self.encryption

    def read_mac(self, mac_type):
        if mac_type != "BASE_MAC":
            raise ValueError("Wrong MAC source")
        return tuple(bytes.fromhex(self.device_id))

    def change_baud(self, _baud):
        pass

    def flash_md5sum(self, offset, size):
        return hashlib.md5(self.flash[offset:offset + size]).hexdigest() if self.backup_valid else "bad"


class FakeEsptool:
    detected_size = "2MB"
    fail_verify = False

    def __init__(self, device, directory):
        self.device = device
        self.directory = directory
        self.events = []
        self.writes = []

    def detect_chip(self, port):
        self.events.append("connect")
        return self.device

    def run_stub(self, device):
        return device

    def attach_flash(self, _device):
        pass

    def detect_flash_size(self, _device):
        return self.detected_size

    def read_flash(self, device, offset, size, **_options):
        self.events.append("backup")
        return bytes(device.flash[offset:offset + size])

    def write_flash(self, device, payloads, **options):
        if not (self.directory / "flash-backup.json").exists():
            raise ValueError("Write attempted before a saved and verified backup")
        if options.get("force") is not False or options.get("erase_all") is not False:
            raise ValueError("Unsafe write options")
        self.events.append("write")
        self.writes.append(payloads)
        for offset, data in payloads:
            device.flash[offset:offset + len(data)] = data

    def verify_flash(self, device, payloads, **_options):
        self.events.append("verify")
        if self.fail_verify or any(device.flash[offset:offset + len(data)] != data for offset, data in payloads):
            raise ValueError("Write verification failed")

    def reset_chip(self, _device, _mode):
        self.events.append("reset")


class InstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sdk = load_sdk(os.environ["IDF_PATH"])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="keyboard-sdk-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk.partitions.offset_part_table = 0x8000
        self.table = self.sdk.partitions.PartitionTable.from_csv(
            "nvs,data,nvs,0x9000,0x6000,\nphy_init,data,phy,0xf000,0x1000,\nfactory,app,factory,0x10000,1M,\n")
        self.firmware = {"settings": {"flash_mode": "dio", "flash_freq": "80m", "flash_size": "2MB"},
                         "security": {"secureBoot": False, "flashEncryption": False, "signedApps": False, "antiRollback": False},
                         "flashBytes": 2097152, "images": []}
        for role, offset in (("bootloader", 0), ("partition-table", 0x8000), ("app", 0x10000)):
            if role == "partition-table":
                data = self.table.to_binary()
            else:
                image = self.sdk.images.ESP32S3FirmwareImage()
                image.chip_id = image.ROM_LOADER.IMAGE_CHIP_ID
                image.segments.append(self.sdk.images.ImageSegment(0x3FC88000, bytes(16)))
                image.segments[0].name = "fixture"
                data = image.save(None)
            self.set_image(role, offset, data)
            self.csv = ("key,type,encoding,value\nkb_identity,namespace,,\nversion,data,u32,1\n"
                    "device_id,data,string,001122334455\nap_password,data,string," + "A" * 24 +
                    "\nclaim_salt,data,hex2bin," + "ab" * 16 + "\nclaim_hash,data,hex2bin," + "cd" * 32 +
                    "\nclaim_cost,data,u32,100000\n")
            (self.root / "identity.csv").write_text(self.csv, encoding="utf-8")
            self.request = {"execute": True, "deviceId": "001122334455", "port": "MOCK", "baud": 460800,
                    "directory": str(self.root), "firmware": self.firmware, "replaceNvs": False}
            self.device = FakeDevice(b"\xff" * 2097152)
            self.transport = FakeEsptool(self.device, self.root)
            self.connected_sdk = SimpleNamespace(partitions=self.sdk.partitions, images=self.sdk.images,
                                 esptool=self.transport)

    def set_image(self, role, offset, data):
        source = self.root / f"{role}.bin"
        source.write_bytes(data)
        self.firmware["images"] = [image for image in self.firmware["images"] if image["role"] != role]
        self.firmware["images"].append({"role": role, "offset": offset, "source": str(source),
                                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})

    def test_official_parser_finds_nvs_and_validates_firmware(self):
        plan = inspect_firmware(self.firmware, self.sdk)
        self.assertEqual(plan["nvs"], {"offset": 0x9000, "size": 0x6000})
        self.assertEqual(plan["partitionTable"]["offset"], 0x8000)

    def test_real_esptool_read_flash_returns_bytes_without_output(self):
        contents = b"\xff" * 4096
        device = SimpleNamespace(read_flash=Mock(return_value=contents))
        with patch("esptool.cmds._set_flash_parameters"):
            result = self.sdk.esptool.read_flash(device, 0, len(contents), no_progress=True)
        self.assertEqual(result, contents)
        device.read_flash.assert_called_once_with(0, len(contents), None)

    def test_real_esptool_write_and_verify_accept_byte_payloads(self):
        contents = bytes(range(256)) * 16
        device = Mock(CHIP_NAME="ESP32-S3", IS_STUB=True, secure_download_mode=False,
                      BOOTLOADER_FLASH_OFFSET=0, FLASH_SECTOR_SIZE=4096, FLASH_WRITE_SIZE=4096,
                      WRITE_FLASH_ATTEMPTS=1)
        device.get_secure_boot_v1_enabled.return_value = False
        device.get_secure_boot_enabled.return_value = False
        device.get_flash_encryption_enabled.return_value = False
        device.flash_md5sum.return_value = hashlib.md5(contents).hexdigest()
        payloads = [(0x9000, contents)]
        with patch("esptool.cmds._set_flash_parameters", return_value="2MB"), \
                patch("esptool.cmds.detect_flash_size", return_value="16MB"):
            self.sdk.esptool.write_flash(device, payloads, flash_size="2MB", erase_all=False,
                                        force=False, no_compress=True, no_progress=True)
            self.sdk.esptool.verify_flash(device, payloads, flash_size="2MB")
        device.flash_begin.assert_called_once_with(len(contents), 0x9000, encrypted_write=False)
        device.flash_block.assert_called_once_with(contents, 0, encrypted=False)
        self.assertEqual(device.flash_md5sum.call_count, 2)
        device.flash_md5sum.assert_called_with(0x9000, len(contents))

    def test_sdk_guard_accepts_only_validated_esptool_versions(self):
        for version in ("5.3.1", "5.4.0"):
            with self.subTest(version=version), patch.object(self.sdk.esptool, "__version__", version):
                self.assertIs(load_sdk(os.environ["IDF_PATH"]).esptool, self.sdk.esptool)
        for version in ("4.9.0", "5.2.0", "5.3.0", "5.5.0", "6.0.0"):
            with self.subTest(version=version), patch.object(self.sdk.esptool, "__version__", version):
                with self.assertRaisesRegex(ValueError, f"found {version}"):
                    load_sdk(os.environ["IDF_PATH"])

    def test_node_cli_validates_build_then_manifest_only_download_without_hardware(self):
        metadata = {"flash_settings": self.firmware["settings"], "flash_files": {},
                    "extra_esptool_args": {"chip": "esp32s3"},
                    "write_flash_args": ["--flash-mode", "dio", "--flash-size", "2MB", "--flash-freq", "80m"]}
        for image in self.firmware["images"]:
            offset = hex(image["offset"])
            name = Path(image["source"]).name
            metadata["flash_files"][offset] = name
            metadata[image["role"]] = {"offset": offset, "file": name, "encrypted": "false"}
        (self.root / "flasher_args.json").write_text(json.dumps(metadata), encoding="utf-8")
        configuration = self.root / "config"
        configuration.mkdir()
        (configuration / "sdkconfig.json").write_text(json.dumps({
            "IDF_TARGET": "esp32s3", "SECURE_BOOT": False, "SECURE_FLASH_ENC_ENABLED": False,
            "UNRELATED_PRIVATE_SETTING": "must-not-be-exported"}), encoding="utf-8")
        command = ["node", str(Path(__file__).with_name("install-device.mjs")), "--firmware", str(self.root),
                   "--idf-path", os.environ["IDF_PATH"], "--python", sys.executable]
        generated = subprocess.run([*command, "--write-manifest"], capture_output=True, text=True, check=False)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        manifest = (self.root / "firmware-manifest.json").read_text(encoding="utf-8")
        self.assertNotIn("must-not-be-exported", manifest)
        self.assertNotIn(str(self.root), manifest)
        (configuration / "sdkconfig.json").unlink()
        configuration.rmdir()
        downloaded = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(downloaded.returncode, 0, downloaded.stderr)
        self.assertIn("Offline check only", downloaded.stdout)
        self.assertFalse((self.root / "identity.bin").exists())
        self.assertFalse((self.root / "install-plan.json").exists())
        self.assertEqual(self.transport.events, [])

    def test_modified_image_is_rejected(self):
        (self.root / "app.bin").write_bytes(bytes(16))
        with self.assertRaisesRegex(ValueError, "changed after validation"):
            inspect_firmware(self.firmware, self.sdk)

    def test_bad_image_digest_is_rejected(self):
        data = bytearray((self.root / "app.bin").read_bytes())
        data[-1] ^= 1
        self.set_image("app", 0x10000, data)
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            inspect_firmware(self.firmware, self.sdk)

    def test_wrong_chip_image_is_rejected(self):
        image = self.sdk.images.ESP32FirmwareImage()
        image.segments.append(self.sdk.images.ImageSegment(0x3FC88000, bytes(16)))
        image.segments[0].name = "fixture"
        self.set_image("app", 0x10000, image.save(None))
        with self.assertRaisesRegex(ValueError, "another chip"):
            inspect_firmware(self.firmware, self.sdk)

    def test_missing_readonly_or_encrypted_nvs_is_rejected(self):
        for attribute, value in (("name", "other"), ("readonly", True), ("encrypted", True)):
            with self.subTest(attribute=attribute):
                original = getattr(self.table["nvs"], attribute)
                partition = self.table["nvs"]
                setattr(partition, attribute, value)
                self.set_image("partition-table", 0x8000, self.table.to_binary())
                with self.assertRaises(ValueError):
                    inspect_firmware(self.firmware, self.sdk)
                setattr(partition, attribute, original)

    def test_application_offset_and_capacity_are_checked(self):
        self.firmware["images"][-1]["offset"] = 0x20000
        with self.assertRaisesRegex(ValueError, "declared partition"):
            inspect_firmware(self.firmware, self.sdk)
        self.firmware["images"][-1]["offset"] = 0x10000
        self.firmware["flashBytes"] = 1048576
        with self.assertRaises(self.sdk.partitions.InputError):
            inspect_firmware(self.firmware, self.sdk)

    def test_official_generator_produces_a_partition_sized_nvs_image(self):
        data = generate_nvs(self.root, "001122334455", 0x6000)
        self.assertEqual(len(data), 0x6000)
        self.assertIn(b"kb_identity", data)
        with self.assertRaisesRegex(ValueError, "already exists"):
            generate_nvs(self.root, "001122334455", 0x6000)

    def test_csv_rejects_a_different_mac_or_unexpected_records_without_secrets(self):
        for contents in (self.csv.replace("001122334455", "aabbccddeeff"),
                         self.csv + "owner,data,string,secret\n",
                         self.csv.replace("claim_hash,data,hex2bin", "claim_hash,file,binary")):
            with self.subTest(contents=contents[:32]):
                with self.assertRaises(ValueError) as error:
                    validate_identity(contents, "001122334455")
                self.assertNotIn("A" * 24, str(error.exception))
                self.assertNotIn("secret", str(error.exception))

    def test_one_combined_write_follows_backup_and_precedes_verification_and_reset(self):
        result = install(self.request, self.connected_sdk)
        self.assertTrue(result["verified"])
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify", "reset"])
        self.assertEqual(len(self.transport.writes), 1)
        self.assertEqual([offset for offset, _data in self.transport.writes[0]], [0, 0x8000, 0x9000, 0x10000])
        self.assertEqual((self.root / "flash-backup.bin").read_bytes(), b"\xff" * 2097152)
        self.assertTrue(self.device.closed)
        self.assertNotIn("A" * 24, (self.root / "install-result.json").read_text())

    def test_no_execute_flag_never_connects(self):
        self.request["execute"] = False
        with self.assertRaisesRegex(ValueError, "--execute"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])

    def test_wrong_mac_never_reads_or_writes_flash(self):
        self.device.device_id = "aabbccddeeff"
        with self.assertRaisesRegex(ValueError, "base MAC"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])
        self.assertTrue(self.device.closed)

    def test_protected_device_never_reads_or_writes_flash(self):
        self.device.encryption = True
        with self.assertRaisesRegex(ValueError, "separate installation"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_secure_boot_never_reads_or_writes_flash(self):
        self.device.secure_boot = True
        with self.assertRaisesRegex(ValueError, "separate installation"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_secure_download_mode_never_reads_or_writes_flash(self):
        self.device.secure_download_mode = True
        with self.assertRaisesRegex(ValueError, "separate installation"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_wrong_board_type_never_reads_or_writes_flash(self):
        self.device.CHIP_NAME = "ESP32"
        with self.assertRaisesRegex(ValueError, "not an ESP32-S3"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_unknown_flash_capacity_never_reads_or_writes(self):
        self.transport.detected_size = None
        with self.assertRaisesRegex(ValueError, "Unknown or unsupported flash capacity"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_unknown_or_insufficient_flash_capacity_never_writes(self):
        self.transport.detected_size = "1MB"
        with self.assertRaisesRegex(ValueError, "smaller"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_backup_verification_failure_never_writes(self):
        self.device.backup_valid = False
        with self.assertRaisesRegex(ValueError, "backup verification"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup"])

    def test_changed_partition_layout_cannot_be_overridden(self):
        self.device.flash[0x8000] = 0
        self.request["replaceNvs"] = True
        with self.assertRaisesRegex(ValueError, "partition table differs"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup"])

    def test_existing_nvs_is_preserved_by_default(self):
        table = (self.root / "partition-table.bin").read_bytes()
        self.device.flash[0x8000:0x8000 + len(table)] = table
        self.device.flash[0x9000] = 0
        with self.assertRaisesRegex(ValueError, "--replace-nvs"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup"])
        self.assertEqual(self.device.flash[0x9000], 0)

    def test_explicit_nvs_replacement_keeps_unrelated_partitions_and_backup(self):
        table = (self.root / "partition-table.bin").read_bytes()
        self.device.flash[0x8000:0x8000 + len(table)] = table
        self.device.flash[0x9000] = 0
        self.device.flash[0xf000] = 0x42
        self.request["replaceNvs"] = True
        install(self.request, self.connected_sdk)
        self.assertEqual(self.device.flash[0xf000], 0x42)
        self.assertEqual((self.root / "flash-backup.bin").read_bytes()[0x9000], 0)

    def test_failed_write_verification_never_resets_or_reports_success(self):
        self.transport.fail_verify = True
        with self.assertRaisesRegex(ValueError, "Write verification failed"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify"])
        self.assertFalse((self.root / "install-result.json").exists())
        self.assertTrue((self.root / "flash-backup.bin").is_file())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--idf-path", default=os.environ.get("IDF_PATH"))
    options, remaining = parser.parse_known_args()
    if options.idf_path:
        os.environ["IDF_PATH"] = options.idf_path
    unittest.main(argv=[__file__, *remaining])