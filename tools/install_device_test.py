import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import espsecure

from install_device import create_private_directory, generate_nvs, inspect_firmware, install, load_sdk, private_write, validate_identity
from ota_artifacts import build_artifacts, inspect_ota_firmware, parse_descriptor, verify_application, verify_manifest


class FakeDevice:
    CHIP_NAME: str = "ESP32-S3"
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
    detected_size: str | None = "2MB"
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
        self.output = self.root / "installation"
        self.sdk.partitions.offset_part_table = 0x8000
        self.table = self.sdk.partitions.PartitionTable.from_csv(
            "nvs,data,nvs,0x9000,0x6000,\nphy_init,data,phy,0xf000,0x1000,\nfactory,app,factory,0x10000,1M,\n")
        self.firmware = {"settings": {"flash_mode": "dio", "flash_freq": "80m", "flash_size": "2MB"},
                         "security": {"secureBoot": False, "flashEncryption": False, "signedApps": False,
                                      "antiRollback": False, "httpDevelopment": True},
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
                    "directory": str(self.output), "identityCsv": self.csv, "firmware": self.firmware, "replaceNvs": False}
            self.device = FakeDevice(b"\xff" * 2097152)
            self.transport = FakeEsptool(self.device, self.output)
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

    def test_identity_policy_rejects_legacy_cost(self):
        fresh = self.csv.replace("claim_cost,data,u32,100000\n", "claim_cost,data,u32,10\n")
        validate_identity(fresh, self.request["deviceId"])
        with self.assertRaisesRegex(ValueError, "claim_cost"):
            validate_identity(self.csv, self.request["deviceId"])

    def test_missing_or_disabled_http_claim_ui_never_connects(self):
        for value in (None, False, "true", 1):
            with self.subTest(value=value):
                self.firmware["security"]["httpDevelopment"] = value
                with self.assertRaisesRegex(ValueError, "HTTP owner-claim"):
                    install(self.request, self.connected_sdk)
        del self.firmware["security"]["httpDevelopment"]
        with self.assertRaisesRegex(ValueError, "HTTP owner-claim"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(self.output.exists())

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
            "KEYBOARD_HTTP_DEVELOPMENT": True,
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
        data = generate_nvs(self.root, "001122334455", 0x6000, 100000)
        self.assertEqual(len(data), 0x6000)
        self.assertIn(b"kb_identity", data)
        with self.assertRaisesRegex(ValueError, "already exists"):
            generate_nvs(self.root, "001122334455", 0x6000, 100000)

    @unittest.skipIf(os.name == "nt", "Directory fsync is POSIX-only")
    def test_generated_nvs_syncs_file_then_directory_before_connecting(self):
        synchronized = []
        original_sync = os.fsync

        def record_sync(descriptor):
            synchronized.append("directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file")
            original_sync(descriptor)

        with patch("install_device.os.fsync", side_effect=record_sync):
            generate_nvs(self.root, "001122334455", 0x6000, 100000)
        self.assertEqual(synchronized, ["file", "directory"])
        self.assertEqual(self.transport.events, [])

    def test_generated_nvs_sync_failure_never_connects(self):
        original_sync = os.fsync

        def fail_generated_image_sync(descriptor):
            if (self.output / "identity.bin").exists():
                raise OSError("NVS image sync failed")
            original_sync(descriptor)

        with patch("install_device.os.fsync", side_effect=fail_generated_image_sync):
            with self.assertRaisesRegex(OSError, "NVS image sync failed"):
                install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse((self.output / "install-plan.json").exists())

    def test_application_fit_includes_the_final_flash_sector(self):
        image = self.sdk.images.ESP32S3FirmwareImage()
        image.chip_id = image.ROM_LOADER.IMAGE_CHIP_ID
        image.segments.append(self.sdk.images.ImageSegment(0x3FC88000, bytes(4096)))
        image.segments[0].name = "fixture"
        data = image.save(None)
        self.assertGreater(len(data), 4096)
        self.assertNotEqual(len(data) % 4096, 0)
        self.set_image("app", 0x10000, data)
        application = self.table.find_by_name("factory")
        self.assertIsNotNone(application)
        assert application is not None
        application.size = len(data)
        self.set_image("partition-table", 0x8000, self.table.to_binary())
        with self.assertRaisesRegex(self.sdk.partitions.ValidationError, "Size .*not aligned"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(self.output.exists())
        application.size = ((len(data) + 4095) // 4096) * 4096
        self.set_image("partition-table", 0x8000, self.table.to_binary())
        inspect_firmware(self.firmware, self.sdk)
        application.size -= 4096
        self.set_image("partition-table", 0x8000, self.table.to_binary())
        with self.assertRaisesRegex(ValueError, "declared partition"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(self.output.exists())

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
        self.assertEqual((self.output / "flash-backup.bin").read_bytes(), b"\xff" * 2097152)
        self.assertTrue(self.device.closed)
        self.assertNotIn("A" * 24, (self.output / "install-result.json").read_text())
        if os.name != "nt":
            self.assertEqual(self.output.stat().st_mode & 0o077, 0)
            self.assertEqual(result["backupDurability"], "file-and-directory-sync")

    def test_existing_installation_directory_never_connects(self):
        self.request["directory"] = str(self.root)
        with self.assertRaises(FileExistsError):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse((self.root / "identity.bin").exists())

    def test_repository_installation_directory_never_connects(self):
        self.request["directory"] = str(Path(__file__).resolve().parents[1] / self.root.name / "device")
        with self.assertRaisesRegex(ValueError, "outside the repository"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(Path(self.request["directory"]).parent.exists())

    @unittest.skipIf(os.name == "nt", "Creating symlinks can require Windows privileges")
    def test_symlinked_installation_directories_never_connect(self):
        repository_link = self.root / "repository-link"
        repository_link.symlink_to(Path(__file__).resolve().parents[1], target_is_directory=True)
        self.request["directory"] = str(repository_link / self.root.name)
        with self.assertRaisesRegex(ValueError, "resolve into the repository"):
            install(self.request, self.connected_sdk)
        self.output.symlink_to(self.root / "missing", target_is_directory=True)
        self.request["directory"] = str(self.output)
        with self.assertRaises(FileExistsError):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse((self.root / "missing").exists())

    def test_windows_acl_is_applied_to_a_new_empty_directory(self):
        def restrict_directory(command, **options):
            self.assertTrue(self.output.is_dir())
            self.assertEqual(list(self.output.iterdir()), [])
            self.assertEqual(command, ["icacls.exe", str(self.output), "/inheritance:r", "/grant:r",
                                       "TESTDOMAIN\\sender:(OI)(CI)F"])
            self.assertEqual(options, {"capture_output": True, "check": False})
            return SimpleNamespace(returncode=0)

        with patch("install_device.sys.platform", "win32"), \
                patch.dict(os.environ, {"USERDOMAIN": "TESTDOMAIN", "USERNAME": "sender"}), \
                patch("install_device.subprocess.run", side_effect=restrict_directory) as permissions:
            self.assertEqual(create_private_directory(self.output), self.output)
        permissions.assert_called_once()

    def test_windows_acl_failure_never_prepares_or_connects(self):
        with patch("install_device.sys.platform", "win32"), \
                patch.dict(os.environ, {"USERDOMAIN": "TESTDOMAIN", "USERNAME": "sender"}), \
                patch("install_device.subprocess.run", return_value=SimpleNamespace(returncode=1)), \
                patch("install_device.generate_nvs") as generate:
            with self.assertRaisesRegex(ValueError, "Cannot restrict Windows"):
                install(self.request, self.connected_sdk)
        generate.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.transport.events, [])

    def test_missing_windows_account_never_prepares_or_connects(self):
        with patch("install_device.sys.platform", "win32"), \
                patch.dict(os.environ, {"USERDOMAIN": "", "USERNAME": ""}), \
                patch("install_device.subprocess.run") as permissions:
            with self.assertRaisesRegex(ValueError, "Cannot identify the Windows account"):
                install(self.request, self.connected_sdk)
        permissions.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.transport.events, [])

    def test_windows_backup_reports_limited_durability(self):
        with patch("install_device.sys.platform", "win32"), \
                patch.dict(os.environ, {"USERDOMAIN": "TESTDOMAIN", "USERNAME": "sender"}), \
                patch("install_device.subprocess.run", return_value=SimpleNamespace(returncode=0)), \
                patch("install_device.generate_nvs", return_value=bytes(0x6000)), \
                patch("install_device.sys.stderr", new_callable=io.StringIO) as diagnostics:
            result = install(self.request, self.connected_sdk)
        self.assertIn("not guaranteed durable across host power loss", diagnostics.getvalue())
        self.assertEqual(result["backupDurability"], "file-sync-only")
        backup = json.loads((self.output / "flash-backup.json").read_text())
        self.assertEqual(backup["durability"], "file-sync-only")
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify", "reset"])

    @unittest.skipIf(os.name == "nt", "POSIX permissions are checked independently of Windows ACLs")
    def test_non_private_directory_mode_is_rejected(self):
        with patch("install_device.Path.stat", return_value=SimpleNamespace(st_uid=os.getuid(), st_mode=0o777)):
            with self.assertRaisesRegex(ValueError, "Installation directory is not private"):
                create_private_directory(self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    @unittest.skipIf(os.name == "nt", "Directory fsync is POSIX-only")
    def test_new_directory_syncs_all_ancestor_entries(self):
        with patch("install_device.sync_directory") as synchronize:
            create_private_directory(self.output)
        self.assertEqual([invocation.args[0] for invocation in synchronize.call_args_list],
                         list(self.output.resolve().parents))

    @unittest.skipIf(os.name == "nt", "Directory fsync is POSIX-only")
    def test_parent_directory_sync_failure_never_prepares_or_connects(self):
        with patch("install_device.sync_directory", side_effect=OSError("Parent directory sync failed")), \
                patch("install_device.generate_nvs") as generate:
            with self.assertRaisesRegex(OSError, "Parent directory sync failed"):
                install(self.request, self.connected_sdk)
        generate.assert_not_called()
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.transport.events, [])

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

    def test_real_esptool_secure_boot_bitmask_allows_unsecured_board(self):
        loader_type = self.sdk.images.ESP32S3FirmwareImage.ROM_LOADER
        registers = SimpleNamespace(
            read_reg=Mock(return_value=0),
            EFUSE_SECURE_BOOT_EN_REG=loader_type.EFUSE_SECURE_BOOT_EN_REG,
            EFUSE_SECURE_BOOT_EN_MASK=loader_type.EFUSE_SECURE_BOOT_EN_MASK)
        with patch.object(self.device, "get_secure_boot_enabled",
                          side_effect=lambda: loader_type.get_secure_boot_enabled(registers)):
            result = install(self.request, self.connected_sdk)
        self.assertTrue(result["verified"])
        registers.read_reg.assert_called_once_with(loader_type.EFUSE_SECURE_BOOT_EN_REG)
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify", "reset"])

    def test_real_esptool_secure_boot_bitmask_rejects_secured_board(self):
        loader_type = self.sdk.images.ESP32S3FirmwareImage.ROM_LOADER
        registers = SimpleNamespace(
            read_reg=Mock(return_value=loader_type.EFUSE_SECURE_BOOT_EN_MASK),
            EFUSE_SECURE_BOOT_EN_REG=loader_type.EFUSE_SECURE_BOOT_EN_REG,
            EFUSE_SECURE_BOOT_EN_MASK=loader_type.EFUSE_SECURE_BOOT_EN_MASK)
        with patch.object(self.device, "get_secure_boot_enabled",
                          side_effect=lambda: loader_type.get_secure_boot_enabled(registers)):
            with self.assertRaisesRegex(ValueError, "separate installation"):
                install(self.request, self.connected_sdk)
        registers.read_reg.assert_called_once_with(loader_type.EFUSE_SECURE_BOOT_EN_REG)
        self.assertEqual(self.transport.events, ["connect"])

    def test_invalid_secure_boot_values_never_read_or_write_flash(self):
        for index, value in enumerate((None, 0.0, "0", "", [], -1)):
            with self.subTest(value=value):
                self.request["directory"] = str(self.root / f"security-{index}")
                self.transport.events.clear()
                with patch.object(self.device, "get_secure_boot_enabled", return_value=value):
                    with self.assertRaisesRegex(ValueError, "separate installation"):
                        install(self.request, self.connected_sdk)
                self.assertEqual(self.transport.events, ["connect"])
                self.assertEqual(self.transport.writes, [])

    def test_secure_download_mode_never_reads_or_writes_flash(self):
        self.device.secure_download_mode = True
        with patch.object(self.device, "get_secure_boot_enabled") as read_secure_boot:
            with self.assertRaisesRegex(ValueError, "separate installation"):
                install(self.request, self.connected_sdk)
        read_secure_boot.assert_not_called()
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

    @unittest.skipIf(os.name == "nt", "Directory fsync is POSIX-only")
    def test_private_write_syncs_file_then_directory(self):
        synchronized = []
        original_sync = os.fsync

        def record_sync(descriptor):
            synchronized.append("directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file")
            original_sync(descriptor)

        with patch("install_device.os.fsync", side_effect=record_sync):
            private_write(self.root, "durability.bin", b"backup")
        self.assertEqual(synchronized, ["file", "directory"])

    @unittest.skipIf(os.name == "nt", "Directory fsync is POSIX-only")
    def test_backup_directory_sync_failure_never_writes(self):
        original_sync = os.fsync

        def fail_backup_directory_sync(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode) and (self.output / "flash-backup.json").exists():
                raise OSError("Backup directory sync failed")
            original_sync(descriptor)

        with patch("install_device.os.fsync", side_effect=fail_backup_directory_sync):
            with self.assertRaisesRegex(OSError, "Backup directory sync failed"):
                install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup"])
        self.assertTrue(self.device.closed)

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
        self.assertEqual((self.output / "flash-backup.bin").read_bytes()[0x9000], 0)

    def test_failed_write_verification_never_resets_or_reports_success(self):
        self.transport.fail_verify = True
        with self.assertRaisesRegex(ValueError, "Write verification failed"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify"])
        self.assertFalse((self.output / "install-result.json").exists())
        self.assertTrue((self.output / "flash-backup.bin").is_file())

    def test_result_persistence_failure_still_resets_a_verified_device(self):
        def fail_result_write(directory, name, data):
            if name == "install-result.json":
                raise OSError("Result persistence failed")
            private_write(directory, name, data)

        with patch("install_device.private_write", side_effect=fail_result_write):
            with self.assertRaisesRegex(OSError, "Result persistence failed"):
                install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "backup", "write", "verify", "reset"])
        self.assertTrue(self.device.closed)
        self.assertFalse((self.output / "install-result.json").exists())
        self.assertTrue((self.output / "flash-backup.bin").is_file())


class FakeOtaEsptool(FakeEsptool):
    detected_size = "16MB"

    def erase_flash(self, device, **options):
        if options != {"force": False} or not (self.directory / "install-plan.json").exists():
            raise ValueError("Unsafe or unprepared erase")
        self.events.append("erase")
        device.flash[:] = b"\xff" * len(device.flash)

    def write_flash(self, device, payloads, **options):
        if self.events != ["connect", "erase"] or options.get("force") is not False or options.get("erase_all") is not False:
            raise ValueError("Write attempted without a guarded erase")
        if options.get("flash_size") != "keep":
            raise ValueError("Signed image headers must not change")
        self.events.append("write")
        self.writes.append(payloads)
        for offset, data in payloads:
            device.flash[offset:offset + len(data)] = data

    def read_flash(self, device, offset, size, **_options):
        self.events.append("readback")
        return bytes(device.flash[offset:offset + size])


class OtaArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sdk = load_sdk(os.environ["IDF_PATH"])
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=3072)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="keyboard-ota-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.build = self.root / "build"
        self.build.mkdir()
        self.key_path = self.root / "test-key.pem"
        self.key_path.write_bytes(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption()))
        self.key_path.chmod(0o600)
        descriptor = struct.pack("<8s8I32s32s32s48s32s40s", b"KBOTA001", 1, 1, 1, 1, 10, 0x1000000, 0x600000, 1,
                                 b"remote-keyboard", b"esp32s3-generic-16m", b"kb16-ab6-nvs64-v1",
                                 b"0123456789abcdef0123456789abcdef01234567", b"0.1.0", bytes(40))
        app_description = bytearray(256)
        struct.pack_into("<I", app_description, 0, 0xABCD5432)
        app_description[16:21] = b"0.1.0"
        app_description[112:116] = b"v6.1"
        image = self.sdk.images.ESP32S3FirmwareImage()
        image.chip_id = image.ROM_LOADER.IMAGE_CHIP_ID
        image.flash_mode = 2
        image.flash_size_freq = 0x4F
        image.segments.append(self.sdk.images.ImageSegment(0x3C020020, bytes(app_description) + descriptor))
        image.segments[0].name = "fixture"
        unsigned = image.save(None)
        (self.build / "app-unsigned.bin").write_bytes(unsigned)
        with self.key_path.open("rb") as keyfile, (self.build / "app-unsigned.bin").open("rb") as datafile:
            espsecure.sign_secure_boot_v2([keyfile], str(self.build / "app.bin"), False, False, None, [], [], datafile)
        self.sdk.partitions.offset_part_table = 0x8000
        table = self.sdk.partitions.PartitionTable.from_csv((Path(__file__).resolve().parents[1] / "partitions.csv").read_text())
        (self.build / "partition-table.bin").write_bytes(table.to_binary())
        (self.build / "bootloader.bin").write_bytes(unsigned)
        (self.build / "otadata.bin").write_bytes(b"\xff" * 8192)
        flash = {"flash_settings": {"flash_mode": "dio", "flash_freq": "80m", "flash_size": "keep"},
                 "write_flash_args": ["--flash-mode", "dio", "--flash-freq", "80m", "--flash-size", "keep"],
                 "extra_esptool_args": {"chip": "esp32s3"}, "flash_files": {}}
        for role, offset in (("bootloader", 0), ("partition-table", 0x8000), ("otadata", 0x19000), ("app", 0x20000)):
            flash[role] = {"offset": hex(offset), "file": f"{role}.bin", "encrypted": "false"}
            flash["flash_files"][hex(offset)] = f"{role}.bin"
        (self.build / "flasher_args.json").write_text(json.dumps(flash))
        configuration = {name: True for name in ("SECURE_SIGNED_APPS_NO_SECURE_BOOT", "SECURE_SIGNED_APPS_RSA_SCHEME",
                         "SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT", "SECURE_BOOT_BUILD_SIGNED_BINARIES",
                         "BOOTLOADER_APP_ROLLBACK_ENABLE", "BOOTLOADER_WDT_ENABLE", "BOOTLOADER_WDT_DISABLE_IN_USER_CODE",
                         "ESP_PHY_CALIBRATION_AND_DATA_STORAGE", "KEYBOARD_HTTP_DEVELOPMENT")}
        configuration.update(ESPTOOLPY_FLASHSIZE="16MB", SECURE_BOOT_SIGNING_KEY=str(self.key_path))
        (self.build / "config").mkdir()
        (self.build / "config/sdkconfig.json").write_text(json.dumps(configuration))
        self.firmware = build_artifacts(self.build, self.sdk, self.root)
        self.output = self.root / "installation"
        self.device = FakeDevice(b"old!" * (0x1000000 // 4))
        self.transport = FakeOtaEsptool(self.device, self.output)
        self.connected_sdk = SimpleNamespace(partitions=self.sdk.partitions, images=self.sdk.images, esptool=self.transport)
        public_pem = self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.csv = ("key,type,encoding,value\nkb_identity,namespace,,\nversion,data,u32,1\n"
                "device_id,data,string,001122334455\nap_password,data,string," + "A" * 24 +
                "\nclaim_salt,data,hex2bin," + "ab" * 16 + "\nclaim_hash,data,hex2bin," + "cd" * 32 +
                "\nclaim_cost,data,u32,10\n")
        self.request = {"execute": True, "deviceId": "001122334455", "port": "MOCK", "baud": 460800,
                "directory": str(self.output), "identityCsv": self.csv, "firmware": self.firmware,
                "resetLayout": True, "verificationKey": public_pem, "allowTestFirmware": True}

    def test_signed_outputs_share_application_and_authenticate_manifest(self):
        verify_manifest(self.firmware, self.key.public_key())
        descriptor = verify_application((self.build / "firmware-ota.bin").read_bytes(), self.key.public_key())
        self.assertEqual(descriptor["kdfIterations"], 10)
        self.assertTrue(descriptor["testOnly"])
        self.assertEqual((self.build / "firmware-ota.bin").read_bytes(), (self.build / "app.bin").read_bytes())
        self.assertEqual(inspect_ota_firmware(self.firmware, self.sdk, self.key.public_key())["nvs"]["size"], 65536)

    def test_installer_public_pem_formats_and_private_key_rejection(self):
        for form in (serialization.PublicFormat.SubjectPublicKeyInfo, serialization.PublicFormat.PKCS1):
            with self.subTest(public_format=form):
                pem = self.key.public_key().public_bytes(serialization.Encoding.PEM, form).decode()
                self.assertEqual(inspect_firmware(self.firmware, self.sdk, pem)["nvs"]["size"], 65536)
        for form in (serialization.PrivateFormat.PKCS8, serialization.PrivateFormat.TraditionalOpenSSL):
            with self.subTest(private_format=form):
                pem = self.key.private_bytes(serialization.Encoding.PEM, form, serialization.NoEncryption()).decode()
                with self.assertRaisesRegex(ValueError, "public verification key"):
                    inspect_firmware(self.firmware, self.sdk, pem)
                with self.assertRaisesRegex(ValueError, "public verification key"):
                    inspect_firmware(self.firmware, self.sdk, self.request["verificationKey"] + pem)
        with self.assertRaises(ValueError):
            inspect_firmware(self.firmware, self.sdk, "-----BEGIN RSA PUBLIC KEY-----\ninvalid\n-----END RSA PUBLIC KEY-----")

    def test_changed_manifest_is_rejected_even_with_matching_image_metadata(self):
        self.firmware["manifest"]["descriptor"]["version"] = "9.9.9"
        with self.assertRaisesRegex(ValueError, "manifest signature"):
            verify_manifest(self.firmware, self.key.public_key())

    def test_changed_payload_is_rejected_before_install(self):
        (self.build / "app.bin").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "changed after validation"):
            inspect_ota_firmware(self.firmware, self.sdk, self.key.public_key())

    def test_wrong_signature_key_and_unsigned_images_are_rejected(self):
        data = (self.build / "app.bin").read_bytes()
        wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=3072).public_key()
        with self.assertRaises(Exception):
            verify_application(data, wrong_key)
        with self.assertRaises(ValueError):
            verify_application(data[:-4096], self.key.public_key())
        with self.assertRaisesRegex(ValueError, "Untrusted"):
            verify_manifest(self.firmware, wrong_key)

    def test_descriptor_rejects_legacy_policy_and_conflicting_versions(self):
        data = bytearray((self.build / "app.bin").read_bytes())
        struct.pack_into("<I", data, 0x120 + 24, 100000)
        with self.assertRaisesRegex(ValueError, "descriptor"):
            parse_descriptor(data)
        data = bytearray((self.build / "app.bin").read_bytes())
        data[48:53] = b"9.9.9"
        with self.assertRaisesRegex(ValueError, "version differs"):
            parse_descriptor(data)

    def test_security_and_target_changes_are_rejected(self):
        self.firmware["settings"]["flash_size"] = "16MB"
        with self.assertRaisesRegex(ValueError, "unchanged flash headers"):
            inspect_ota_firmware(self.firmware, self.sdk, self.key.public_key())
        self.firmware["settings"]["flash_size"] = "keep"
        self.firmware["images"][0]["offset"] = 4096
        with self.assertRaisesRegex(ValueError, "offset"):
            inspect_ota_firmware(self.firmware, self.sdk, self.key.public_key())

    def test_packaging_rejects_hardware_security_before_reading_key_or_writing_outputs(self):
        config_path = self.build / "config/sdkconfig.json"
        original = json.loads(config_path.read_text())
        before = {name: (self.build / name).read_bytes() for name in (
            "firmware-manifest.json", "firmware-manifest.sig", "firmware-install.zip", "firmware-ota.bin")}
        for flag in ("SECURE_BOOT", "SECURE_BOOT_V2_ENABLED", "SECURE_FLASH_ENC_ENABLED", "BOOTLOADER_APP_ANTI_ROLLBACK"):
            with self.subTest(flag=flag), patch("ota_artifacts.serialization.load_pem_private_key") as load_key:
                config_path.write_text(json.dumps({**original, flag: True}))
                with self.assertRaisesRegex(ValueError, "Unsupported OTA hardware security"):
                    build_artifacts(self.build, self.sdk, self.root)
                load_key.assert_not_called()
                self.assertEqual(before, {name: (self.build / name).read_bytes() for name in before})

    def test_fresh_install_erases_unknown_old_layout_without_migration_or_backup(self):
        result = install(self.request, self.connected_sdk)
        self.assertTrue(result["verified"] and result["resetLayout"])
        self.assertEqual(self.transport.events, ["connect", "erase", "write", "verify", "readback", "reset"])
        self.assertFalse((self.output / "flash-backup.bin").exists())
        self.assertEqual(self.device.flash[0x9000:0x19000], (self.output / "identity.bin").read_bytes())
        self.assertEqual(self.device.flash[0x620000:], b"\xff" * (0x1000000 - 0x620000))
        self.assertTrue(self.device.closed)
        recorded = json.loads((self.output / "install-plan.json").read_text())
        self.assertEqual(recorded["layout"]["verifiedSigningKeySha256"], self.firmware["manifest"]["signingKeySha256"])

    def test_release_packaging_rejects_untracked_staged_and_failed_git_checks(self):
        project = self.root / "release-project"
        subprocess.run(["git", "init", "--quiet", str(project)], capture_output=True, check=True)
        config_path = self.build / "config/sdkconfig.json"
        configuration = json.loads(config_path.read_text())
        config_path.write_text(json.dumps({**configuration, "KEYBOARD_RELEASE": True}))
        source = project / "extra-source.c"
        source.write_text("int unreviewed_source;\n")
        before = {name: (self.build / name).read_bytes() for name in (
            "firmware-manifest.json", "firmware-manifest.sig", "firmware-install.zip", "firmware-ota.bin")}
        for staged in (False, True):
            if staged:
                subprocess.run(["git", "add", "--", source.name], cwd=project, capture_output=True, check=True)
            with self.subTest(staged=staged), patch("ota_artifacts.serialization.load_pem_private_key") as load_key:
                with self.assertRaisesRegex(ValueError, "verified clean worktree"):
                    build_artifacts(self.build, self.sdk, project)
                load_key.assert_not_called()
                self.assertEqual(before, {name: (self.build / name).read_bytes() for name in before})
        with patch("ota_artifacts.subprocess.run", return_value=SimpleNamespace(returncode=128, stdout=b"")) as status, \
                patch("ota_artifacts.serialization.load_pem_private_key") as load_key:
            with self.assertRaisesRegex(ValueError, "verified clean worktree"):
                build_artifacts(self.build, self.sdk, project)
            status.assert_called_once_with(["git", "status", "--porcelain=v1", "--untracked-files=all"],
                                           cwd=project, capture_output=True, check=False)
            load_key.assert_not_called()
            self.assertEqual(before, {name: (self.build / name).read_bytes() for name in before})

    def test_missing_reset_or_test_key_consent_never_connects(self):
        for field in ("resetLayout", "allowTestFirmware"):
            with self.subTest(field=field):
                request = {**self.request, field: False}
                with self.assertRaises(ValueError):
                    install(request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(self.output.exists())

    def test_untrusted_manifest_never_connects_or_creates_credentials(self):
        self.request["firmware"]["manifest"]["flashBytes"] = 0x2000000
        with self.assertRaisesRegex(ValueError, "manifest signature"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, [])
        self.assertFalse(self.output.exists())

    def test_wrong_device_never_erases(self):
        self.device.device_id = "ffeeddccbbaa"
        with self.assertRaisesRegex(ValueError, "MAC mismatch"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])
        self.assertEqual(self.device.flash[:4], b"old!")

    def test_wrong_capacity_never_erases(self):
        self.transport.detected_size = "8MB"
        with self.assertRaisesRegex(ValueError, "16 MiB"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect"])

    def test_failed_fresh_install_never_resets_and_retains_prepared_credentials(self):
        self.transport.fail_verify = True
        with self.assertRaisesRegex(ValueError, "verification failed"):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "erase", "write", "verify"])
        self.assertTrue((self.output / "identity.bin").exists())
        self.assertFalse((self.output / "install-result.json").exists())
        with self.assertRaises(FileExistsError):
            install(self.request, self.connected_sdk)
        self.assertEqual(self.transport.events, ["connect", "erase", "write", "verify"])

    def test_node_inspects_signed_bundle_and_requires_explicit_trusted_key(self):
        public_path = self.root / "trusted-public.pem"
        script = str(Path(__file__).with_name("install-device.mjs"))
        command = ["node", script, "--firmware", str(self.build), "--idf-path", os.environ["IDF_PATH"], "--python", sys.executable]
        failed = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("verification-key", failed.stderr)
        for form in (serialization.PublicFormat.SubjectPublicKeyInfo, serialization.PublicFormat.PKCS1):
            with self.subTest(public_format=form):
                public_path.write_bytes(self.key.public_key().public_bytes(serialization.Encoding.PEM, form))
                accepted = subprocess.run(command + ["--verification-key", str(public_path)], capture_output=True, text=True, check=False)
                self.assertEqual(accepted.returncode, 0, accepted.stderr)
                self.assertIn("Offline check only", accepted.stdout)
        for form in (serialization.PrivateFormat.PKCS8, serialization.PrivateFormat.TraditionalOpenSSL):
            with self.subTest(private_format=form):
                public_path.write_bytes(self.key.private_bytes(serialization.Encoding.PEM, form, serialization.NoEncryption()))
                rejected = subprocess.run(command + ["--verification-key", str(public_path)], capture_output=True, text=True, check=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("public verification key", rejected.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--idf-path", default=os.environ.get("IDF_PATH"))
    options, remaining = parser.parse_known_args()
    if options.idf_path:
        os.environ["IDF_PATH"] = options.idf_path
    unittest.main(argv=[__file__, *remaining])