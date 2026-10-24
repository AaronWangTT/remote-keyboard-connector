"""Focused host-only tests. No test opens a serial port."""

import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import network_nvs as tool


IDF_PATH = Path(os.environ.get("IDF_PATH", Path.home() / ".espressif/v6.1/esp-idf"))
ROOT = Path(__file__).resolve().parents[1]


def empty_image(pages=6):
    return b"\xff" * (pages * tool.PAGE)


def page_image(records, pages=6):
    page = bytearray(b"\xff" * tool.PAGE)
    struct.pack_into("<II", page, 0, 0xFFFFFFFE, 0)
    page[8] = 0xFE
    struct.pack_into("<I", page, 28, tool.crc(page[4:28]))
    index = 0
    for entry, payload in records:
        index = tool.append_record(page, index, entry, payload)
    return bytes(page) + empty_image(pages - 1)


def fixture_image():
    return page_image([
        (tool.make_entry(0, 1, b"kb_identity", b"\1"), b""),
        (tool.make_entry(1, 8, b"owner", b"\x12\x34\x56\x78\x9a\xbc\xde\xf0"), b""),
        # Unknown future type: raw preservation must not depend on a CSV encoding.
        (tool.make_entry(1, 0x7E, b"future", b"opaque!!"), b""),
    ])


def profile(ssid=b"home", password=b"password", verified=False):
    return tool.Profile(ssid, password, verified)


def saved_image(settings=None):
    return tool.plan_update(fixture_image(), settings or tool.Settings(
        True, b"keyboard", (profile(),)))[1]


class FormatTests(unittest.TestCase):
    def test_contract_and_endian_independent_offsets(self):
        settings = tool.Settings(True, b"kb", (profile(b"\xffwifi", verified=True),))
        data = tool.encode_settings(settings)
        self.assertEqual(len(data), 1017)
        self.assertEqual(data[:4], b"\2\1\1\0")
        self.assertEqual(data[4:37], b"kb" + bytes(31))
        self.assertEqual(data[37:70], b"\xffwifi" + bytes(28))
        self.assertEqual(data[70:134], b"password" + bytes(56))
        self.assertEqual(data[134], 1)
        self.assertEqual(data[135:], bytes(882))
        self.assertEqual(tool.decode_settings(data), settings)

    def test_ten_maximum_size_profiles(self):
        profiles = tuple(profile(bytes((65 + i,)) * 32, b"p" * 63) for i in range(10))
        settings = tool.Settings(True, b"h" * 32, profiles)
        self.assertEqual(tool.decode_settings(tool.encode_settings(settings)), settings)

    def test_reject_invalid_contract(self):
        valid = tool.encode_settings(tool.Settings(True, b"kb", (profile(),)))
        for offset, value in [(0, 1), (1, 2), (2, 11), (3, 1), (134, 2), (140, 1), (36, 1)]:
            corrupt = bytearray(valid)
            corrupt[offset] = value
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                tool.decode_settings(bytes(corrupt))
        for bad in (profile(b""), profile(b"x" * 33), profile(b"x\0"),
                    profile(password=b"short"), profile(password=b"p" * 64),
                    profile(password=b"\x7f" * 8), profile(password=b"\xff" * 8)):
            with self.subTest(profile=bad.ssid), self.assertRaises(ValueError):
                tool.encode_settings(tool.Settings(hostname=b"kb", profiles=(bad,)))
        with self.assertRaises(ValueError):
            tool.encode_settings(tool.Settings(hostname=b"kb", profiles=(profile(), profile())))

    def test_hostname_and_station_match_firmware_rules(self):
        for hostname in (b"", b"KB", b"-kb", b"kb-", b"kb.local", b"localhost",
                         b"a" * 33, b"kb\0ignored", b"\xff"):
            with self.subTest(hostname=hostname), self.assertRaisesRegex(tool.ToolError, "hostname"):
                tool.encode_settings(tool.Settings(True, hostname, (profile(),)))
        for hostname in (b"k", b"0", b"kb-2", b"a" * 32):
            settings = tool.Settings(True, hostname, (profile(),))
            self.assertEqual(tool.decode_settings(tool.encode_settings(settings)), settings)
        with self.assertRaisesRegex(tool.ToolError, "Station mode"):
            tool.encode_settings(tool.Settings(True, b"kb"))

    def test_legacy(self):
        legacy = (struct.pack("<I", 1) + b"\1" + b"keyboard".ljust(33, b"\0") +
                  b"old".ljust(33, b"\0") + b"old-pass".ljust(64, b"\0") + b"\0")
        self.assertEqual(len(legacy), 136)
        self.assertEqual(tool.decode_legacy(legacy),
                         tool.Settings(True, b"keyboard", (profile(b"old", b"old-pass"),)))
        with self.assertRaises(ValueError):
            tool.decode_legacy(legacy[:-1] + b"\1")

    def test_native_c_fixture_matches_python_abi(self):
        binary = ROOT / ".cache/tests/network_profiles_fixture_test"
        if not binary.is_file():
            self.skipTest("Native ABI fixture absent: build .cache/tests/network_profiles_fixture_test "
                          "with --emit-fixture PATH support")
        fixture = Path(".cache/tests/network_profiles_fixture.bin")
        destination = ROOT / fixture
        destination.unlink(missing_ok=True)
        subprocess.run([str(binary), "--emit-fixture", str(fixture)], cwd=ROOT,
                       capture_output=True, check=True, timeout=10)
        self.assertTrue(destination.is_file(), "Native fixture did not emit the requested file")
        data = destination.read_bytes()
        expected = tool.Settings(True, b"fixture-host", (
            profile(b"fixture-main", b"fixture-pass", True),
            profile(b"\xffwifi", b"second-pass", False),
        ))
        self.assertEqual(tool.decode_settings(data), expected)
        self.assertEqual(tool.encode_settings(expected), data)

    def test_first_use_and_hostname_records_validate_in_firmware(self):
        binary = ROOT / ".cache/tests/network_profiles_fixture_test"
        if not binary.is_file():
            self.skipTest("Build the native network_profiles_fixture suite first")
        with tempfile.TemporaryDirectory(prefix="keyboard-abi-") as directory:
            destination = Path(directory) / "record.bin"
            def native_valid(data):
                destination.write_bytes(data)
                result = subprocess.run([str(binary), "--validate-fixture", str(destination)],
                                        capture_output=True, check=False, timeout=10)
                self.assertIn(result.returncode, (0, 1))
                return result.returncode == 0
            for hostname in ("k", "0", "kb-2", "a" * 32):
                added = tool.modify(tool.Settings(), "import",
                                    payload=[{"ssid": "home", "password": "password"}], hostname=hostname)
                data = tool.encode_settings(added)
                self.assertTrue(native_valid(data))
            for hostname in (b"", b"KB", b"-kb", b"kb-", b"kb.local", b"localhost", b"\xff"):
                data = bytearray(tool.encode_settings(added))
                data[4:37] = hostname.ljust(33, b"\0")
                with self.subTest(hostname=hostname):
                    self.assertFalse(native_valid(bytes(data)))
                    with self.assertRaises(tool.ToolError):
                        tool.decode_settings(bytes(data))


class CrudTests(unittest.TestCase):
    def test_first_add_last_delete_and_preserve_hostname(self):
        settings = tool.Settings(False, b"custom")
        added = tool.modify(settings, "add", payload={"ssid": "home", "password": "password"})
        self.assertTrue(added.station)
        self.assertEqual(added.hostname, b"custom")
        deleted = tool.modify(added, "delete", b"home")
        self.assertFalse(deleted.station)
        self.assertEqual(deleted.hostname, b"custom")

    def test_update_rename_appends_unverified_preserves_others(self):
        a, b = profile(b"a", verified=True), profile(b"b", verified=True)
        settings = tool.Settings(False, b"unchanged", (a, b))
        updated = tool.modify(settings, "update", b"a", {"ssid_hex": "ff", "password": "new-pass"})
        self.assertEqual(updated.profiles, (b, profile(b"\xff", b"new-pass")))
        self.assertFalse(updated.station)
        self.assertEqual(updated.hostname, settings.hostname)
        with self.assertRaises(ValueError):
            tool.modify(settings, "update", b"a", {"ssid": "b"})

    def test_update_password_only_and_settings_only(self):
        settings = tool.Settings(True, b"kb", (profile(verified=True),))
        updated = tool.modify(settings, "update", b"home", {"password": "changed!"})
        self.assertFalse(updated.profiles[0].verified)
        self.assertEqual(updated.profiles[0].ssid, b"home")
        same = tool.modify(settings, "update", b"home", {"ssid": "home"}, hostname="new", station=0)
        self.assertTrue(same.profiles[0].verified)
        self.assertFalse(same.station)

    def test_unchanged_unverified_profile_preserves_order(self):
        a, b, c = profile(b"a"), profile(b"b", verified=True), profile(b"c")
        settings = tool.Settings(True, b"kb", (a, b, c))
        for payload in ({"ssid": "a"}, {"password": "password"}):
            updated = tool.modify(settings, "update", b"a", payload, hostname="new", station=0)
            self.assertEqual(updated.profiles, settings.profiles)
            self.assertEqual(updated.hostname, b"new")
            self.assertFalse(updated.station)
        changed = tool.modify(settings, "update", b"a", {"password": "changed!"})
        self.assertEqual(changed.profiles, (b, c, profile(b"a", b"changed!")))

    def test_first_add_and_import_require_explicit_hostname(self):
        for operation, payload in (("add", {"ssid": "home", "password": "password"}),
                                   ("import", [{"ssid": "home", "password": "password"}])):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(tool.ToolError, "--hostname"):
                    tool.modify(tool.Settings(), operation, payload=payload)
                added = tool.modify(tool.Settings(), operation, payload=payload, hostname="first-use")
                self.assertTrue(added.station)
                self.assertEqual(added.hostname, b"first-use")
                self.assertEqual(tool.decode_settings(tool.encode_settings(added)), added)

    def test_merge_atomic_no_eviction(self):
        profiles = tuple(profile(str(i).encode(), verified=True) for i in range(10))
        settings = tool.Settings(True, b"kb", profiles)
        with self.assertRaises(ValueError):
            tool.modify(settings, "import", payload=[{"ssid": "new", "password": "password"}])
        self.assertEqual(settings.profiles, profiles)
        updated = tool.modify(settings, "import", payload=[
            {"ssid": "2", "password": "changed!"}, {"ssid": "1", "password": "password"}])
        self.assertEqual(len(updated.profiles), 10)
        self.assertEqual(updated.profiles[-1], profile(b"2", b"changed!"))
        self.assertEqual(updated.profiles[1], profiles[1])
        with self.assertRaises(ValueError):
            tool.modify(settings, "import", payload=[
                {"ssid": "x", "password": "password"}, {"ssid_hex": "78", "password": "password"}])

    def test_redacted_and_exact_selectors(self):
        settings = tool.Settings(True, b"kb", (profile(b"\xffssid", b"secret!!"),))
        output = json.dumps(tool.redacted(settings))
        self.assertNotIn("secret!!", output)
        self.assertIn("[redacted]", output)
        self.assertEqual(tool.parse_ssid({"ssid_hex": "ff73736964"}), b"\xffssid")
        for value in ({"ssid": "x", "ssid_hex": "78"}, {"ssid_hex": "0x78"},
                      {"ssid_hex": "00"}, {"ssid": "x" * 33}):
            with self.assertRaises(ValueError):
                tool.parse_ssid(value)


class CredentialTests(unittest.TestCase):
    def load(self, contents, mode=0o100600, symlink=False, inside=False):
        path = Mock()
        path.is_symlink.return_value = symlink
        path.resolve.return_value.is_relative_to.return_value = inside
        source = Mock()
        source.fileno.return_value = 99
        source.read.return_value = contents
        real_path = Path
        with patch.object(tool, "Path", side_effect=lambda value:
                          path if value == "credentials.json" else real_path(value)), \
             patch.object(tool.os, "open", return_value=99), \
             patch.object(tool.os, "fdopen", return_value=contextlib.nullcontext(source)), \
             patch.object(tool.os, "fstat", return_value=argparse.Namespace(
                 st_mode=mode, st_uid=os.getuid())):
            return tool.read_credentials("credentials.json")

    def test_private_file_and_safe_errors(self):
        payload = '{"ssid":"home","password":"do-not-log"}'
        self.assertEqual(self.load(payload)["password"], "do-not-log")
        for kwargs in ({"mode": 0o100644}, {"symlink": True}, {"inside": True},
                       {"mode": 0o040700}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.load(payload, **kwargs)
        for invalid in ('{"password":"do-not-log",}', '{"password":"one","password":"two"}'):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError) as raised:
                    self.load(invalid)
                self.assertNotIn("do-not-log", str(raised.exception))


class RawTests(unittest.TestCase):
    def test_raw_unknown_and_identity_preserved_both_phases(self):
        image = saved_image()
        original = tool.RawNVS(image)
        settings = tool.Settings(True, b"new", (profile(b"new"),))
        phases = tool.plan_update(image, settings)
        for phase in phases:
            self.assertEqual(phase[64:160], image[64:160])
            parsed = tool.RawNVS(phase)
            self.assertEqual(parsed.namespaces[b"kb_identity"], original.namespaces[b"kb_identity"])
        self.assertEqual(tool.RawNVS(phases[0]).settings(), original.settings())
        self.assertEqual(tool.RawNVS(phases[1]).settings(), settings)
        self.assertEqual(tool.RawNVS(phases[1]).selected(tool.ACTIVE_KEY), 1)

    def test_multiple_updates_slots_and_no_compaction(self):
        image = saved_image()
        for number in range(3):
            settings = tool.Settings(True, b"kb", (profile(str(number).encode()),))
            image = tool.plan_update(image, settings)[1]
            self.assertEqual(tool.RawNVS(image).settings(), settings)
        with self.assertRaisesRegex(ValueError, "two erased"):
            tool.plan_update(image, settings)

    def test_crc_bad_state_encryption_and_interrupted_refused(self):
        image = saved_image()
        for offset, value in ((8, 0xFF), (0, 0xF8), (28, 0), (72, 0),
                              (32, 0xFD), (200, 1)):
            bad = bytearray(image)
            bad[offset] = value
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                tool.RawNVS(bytes(bad))
        with self.assertRaises(ValueError):
            tool.RawNVS(bytes(len(image)))

    def test_legacy_keys_untouched_and_new_format_preferred(self):
        legacy = (struct.pack("<I", 1) + b"\1" + b"old-host".ljust(33, b"\0") +
                  b"old".ljust(33, b"\0") + b"old-pass".ljust(64, b"\0") + b"\0")
        records = [(tool.make_entry(0, 1, tool.NAMESPACE, b"\1"), b""),
                   (tool.make_entry(1, 1, b"active", b"\0"), b""),
                   (tool.make_entry(1, 0x41, b"slot0",
                    struct.pack("<H", 136) + b"\xff\xff" + struct.pack("<I", tool.crc(legacy)),
                    6), legacy)]
        image = page_image(records)
        self.assertEqual(tool.RawNVS(image).settings().hostname, b"old-host")
        new = tool.Settings(True, b"new-host", (profile(),))
        result = tool.plan_update(image, new)[1]
        self.assertEqual(result[32:64 + 8 * 32], image[32:64 + 8 * 32])
        self.assertEqual(tool.RawNVS(result).settings(), new)


class FakeDirectory:
    def __init__(self):
        self.files = {}

    def __truediv__(self, name):
        return self.files[name]

    def __str__(self):
        return "/private/mock-backup"


class DeviceTests(unittest.TestCase):
    def setUp(self):
        self.original = saved_image()
        self.image = self.original
        self.table_data = b"T" * tool.PAGE
        self.events = []
        self.connection = Mock()
        self.connection.CHIP_NAME = "ESP32-S3"
        self.connection.secure_download_mode = False
        self.connection.get_secure_boot_enabled.return_value = False
        self.connection.get_flash_encryption_enabled.return_value = False
        self.connection.read_mac.return_value = bytes.fromhex("123456789abc")
        self.sdk = Mock()
        self.sdk.esptool.detect_chip.return_value.__enter__ = Mock(return_value=self.connection)
        self.sdk.esptool.detect_chip.return_value.__exit__ = Mock(return_value=False)
        self.sdk.esptool.run_stub.return_value = self.connection
        self.sdk.esptool.detect_flash_size.return_value = "8MB"
        self.sdk.esptool.read_flash.side_effect = self.read
        self.sdk.esptool.write_flash.side_effect = self.write
        self.partition = argparse.Namespace(offset=0x9000, size=len(self.image))
        self.args = argparse.Namespace(operation="add", port="/dev/never-opened",
            device_id="123456789abc", execute=True, allow_nvs_rewrite=True,
            backup_dir="/private/mock-backup", partition_table_offset=0x8000,
            selector=None, hostname=None, station=None)
        self.directory = FakeDirectory()

    def read(self, device, offset, size, **kwargs):
        return self.table_data if offset == 0x8000 else self.image

    def write(self, device, payloads, **kwargs):
        self.assertIn("nvs-backup.bin", self.directory.files)
        self.assertIn("nvs-backup.json", self.directory.files)
        self.assertFalse(kwargs["erase_all"])
        self.assertFalse(kwargs["force"])
        self.assertEqual(len(payloads), 1)
        offset, self.image = payloads[0]
        self.assertEqual(offset, 0x9000)
        self.assertEqual(len(self.image), len(self.original))
        self.assertEqual(self.image[64:160], self.original[64:160])
        self.events.append("write")

    def backup(self, directory, name, data):
        self.events.append(name)
        source = Mock()
        source.read_bytes.return_value = data
        directory.files[name] = source

    def execute(self):
        with patch.object(tool, "inspect_partition", return_value=self.partition), \
             patch.object(tool, "create_private_directory", return_value=self.directory), \
             patch.object(tool, "private_write", side_effect=self.backup):
            return tool.transact(self.args, self.sdk, {"ssid": "new", "password": "secret!!"})

    def test_verified_backup_before_two_nvs_only_writes_and_reset(self):
        result = self.execute()
        self.assertEqual(self.events, ["nvs-backup.bin", "nvs-backup.json", "write", "write"])
        self.assertTrue(result["verified"])
        self.assertNotIn("secret!!", json.dumps(result))
        self.sdk.esptool.reset_chip.assert_called_once_with(self.connection, "hard-reset")
        self.sdk.esptool.detect_chip.assert_called_once_with(port="/dev/never-opened")

    def test_missing_first_use_hostname_refuses_before_write(self):
        self.image = fixture_image()
        with self.assertRaisesRegex(tool.ToolError, "--hostname"):
            self.execute()
        self.sdk.esptool.write_flash.assert_not_called()
        self.assertEqual(self.events, [])
        self.args.hostname = "first-use"
        result = self.execute()
        self.assertTrue(result["verified"])
        self.assertEqual(result["hostname"], "first-use")

    def test_no_execute_or_ack_never_connects(self):
        for flag in ("execute", "allow_nvs_rewrite"):
            with self.subTest(flag=flag):
                setattr(self.args, flag, False)
                with self.assertRaises(ValueError):
                    self.execute()
                self.sdk.esptool.detect_chip.assert_not_called()
                setattr(self.args, flag, True)
        self.args.device_id = "not-a-mac"
        with self.assertRaises(ValueError):
            self.execute()
        self.sdk.esptool.detect_chip.assert_not_called()

    def test_wrong_mac_encrypted_or_wrong_chip_never_writes_and_resets(self):
        cases = [("read_mac", b"\0" * 6), ("get_flash_encryption_enabled", True),
                 ("get_secure_boot_enabled", True)]
        for method, value in cases:
            with self.subTest(method=method):
                current = getattr(self.connection, method).return_value
                getattr(self.connection, method).return_value = value
                with self.assertRaises(ValueError):
                    self.execute()
                self.sdk.esptool.write_flash.assert_not_called()
                getattr(self.connection, method).return_value = current
        self.connection.CHIP_NAME = "ESP32"
        with self.assertRaises(ValueError):
            self.execute()
        self.sdk.esptool.write_flash.assert_not_called()
        self.assertEqual(self.sdk.esptool.reset_chip.call_count, 4)

    def test_backup_failure_prevents_write_and_resets(self):
        with patch.object(tool, "inspect_partition", return_value=self.partition), \
             patch.object(tool, "create_private_directory", side_effect=OSError("denied")):
            with self.assertRaises(OSError):
                tool.transact(self.args, self.sdk, {"ssid": "new", "password": "secret!!"})
        self.sdk.esptool.write_flash.assert_not_called()
        self.sdk.esptool.reset_chip.assert_called_once()

    def test_readback_failure_stops_before_active_commit(self):
        real_write = self.sdk.esptool.write_flash.side_effect

        def corrupt(*args, **kwargs):
            real_write(*args, **kwargs)
            self.image = self.original

        self.sdk.esptool.write_flash.side_effect = corrupt
        with self.assertRaisesRegex(ValueError, "readback"):
            self.execute()
        self.assertEqual(self.sdk.esptool.write_flash.call_count, 1)
        self.sdk.esptool.reset_chip.assert_called_once()

    def test_changed_flash_and_full_partition_refuse_before_write(self):
        original_read = self.sdk.esptool.read_flash.side_effect
        reads = 0

        def changed(*args, **kwargs):
            nonlocal reads
            reads += 1
            result = original_read(*args, **kwargs)
            return b"\0" * len(result) if reads == 4 else result

        self.sdk.esptool.read_flash.side_effect = changed
        with self.assertRaisesRegex(ValueError, "changed"):
            self.execute()
        self.sdk.esptool.write_flash.assert_not_called()
        self.sdk.esptool.read_flash.side_effect = original_read
        self.image = saved_image(tool.Settings(True, b"kb", tuple(
            profile(str(i).encode()) for i in range(10))))
        with self.assertRaises(ValueError):
            self.execute()
        self.sdk.esptool.write_flash.assert_not_called()

    def test_list_is_redacted_no_write_or_backup(self):
        self.args.operation = "list"
        self.args.execute = False
        result = self.execute()
        self.assertEqual(result["profiles"][0]["password"], "[redacted]")
        self.assertEqual(self.events, [])
        self.sdk.esptool.write_flash.assert_not_called()
        self.sdk.esptool.reset_chip.assert_called_once()


class SDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from esp_idf_nvs_partition_gen import nvs_partition_gen
        except ModuleNotFoundError as error:
            if error.name not in ("esp_idf_nvs_partition_gen", "esp_idf_nvs_partition_gen.nvs_partition_gen"):
                raise
            raise unittest.SkipTest("ESP-IDF NVS generator unavailable; activate the SDK environment")
        cls.generator = nvs_partition_gen
        parser_path = IDF_PATH / "components/nvs_flash/nvs_partition_tool/nvs_parser.py"
        if not parser_path.is_file():
            raise unittest.SkipTest("ESP-IDF NVS parser unavailable; set IDF_PATH")
        spec = importlib.util.spec_from_file_location("sdk_nvs_parser", parser_path)
        cls.parser = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.parser)
        cls.sdk = tool.load_sdk(IDF_PATH)

    def test_real_generator_parser_and_raw_preservation(self):
        output = io.BytesIO()
        gen = self.generator
        with gen.NVS(output, 5 * tool.PAGE, gen.Page.VERSION2) as nvs:
            nvs.write_namespace("kb_identity")
            nvs.write_entry("device_id", "123456789abc", "string")
            nvs.write_entry("owner", "AA" * 80, "hex2bin")
            nvs.write_entry("negative", "-123", "i32")
            nvs.write_namespace("future")
            nvs.write_entry("multichunk", "11" * 5000, "hex2bin")
        image = output.getvalue()
        raw = tool.RawNVS(image)
        self.assertEqual(raw.blob(raw.namespaces[b"future"], b"multichunk"), b"\x11" * 5000)
        expected = tool.Settings(True, b"host", (profile(),))
        updated = tool.plan_update(image, expected)[1]
        self.assertEqual(tool.RawNVS(updated).settings(), expected)
        for record in raw.records:
            start = record.page + 64 + record.index * 32
            end = start + record.span * 32
            self.assertEqual(updated[start:end], image[start:end])
        partition = self.parser.NVS_Partition("nvs", bytearray(updated))
        for page in partition.pages:
            if not page.is_empty:
                self.assertEqual(page.header["crc"]["original"], page.header["crc"]["computed"])
                for entry in page.entries:
                    if entry.state == "Written":
                        self.assertEqual(entry.metadata["crc"]["original"],
                                         entry.metadata["crc"]["computed"])
        network = tool.RawNVS(updated)
        namespace = network.namespaces[tool.NAMESPACE]
        # SDK generator must independently produce exactly the same blob/chunk entries.
        output = io.BytesIO()
        with gen.NVS(output, 2 * tool.PAGE, gen.Page.VERSION2) as nvs:
            nvs.write_namespace("kb_network")
            nvs.write_entry("profiles0", tool.encode_settings(expected).hex(), "hex2bin")
            nvs.write_entry("profiles_active", "0", "u8")
        generated = tool.RawNVS(output.getvalue())
        self.assertEqual(generated.settings(), expected)
        for record in generated.find(1, b"profiles0"):
            counterpart = next(r for r in network.find(namespace, b"profiles0")
                               if r.kind == record.kind)
            a = generated.image[record.page + 64 + record.index * 32:
                                record.page + 64 + (record.index + record.span) * 32]
            b = updated[counterpart.page + 64 + counterpart.index * 32:
                        counterpart.page + 64 + (counterpart.index + counterpart.span) * 32]
            # Namespace and its header CRC differ; all other encoding bytes must agree.
            self.assertEqual(a[1:4] + a[8:], b[1:4] + b[8:])

    def test_real_partition_table_validation_and_encryption_refusal(self):
        table = self.sdk.partitions.PartitionTable.from_csv(
            "nvs,data,nvs,0x9000,0x6000,\nfactory,app,factory,0x10000,0x100000,\n")
        data = table.to_binary().ljust(tool.PAGE, b"\xff")
        nvs = tool.inspect_partition(data, self.sdk, 8 * 1048576, 0x8000)
        self.assertEqual(nvs.offset, 0x9000)
        table.find_by_name("nvs").encrypted = True
        with self.assertRaises(ValueError):
            tool.inspect_partition(table.to_binary().ljust(tool.PAGE, b"\xff"),
                                   self.sdk, 8 * 1048576, 0x8000)

    def test_current_partition_layouts_admit_initial_provisioned_nvs(self):
        gen = self.generator
        for filename, capacity in (("partitions.csv", 16 * 1048576),
                                   ("partitions.xiao-esp32s3.csv", 8 * 1048576)):
            with self.subTest(layout=filename):
                table = self.sdk.partitions.PartitionTable.from_csv(
                    (ROOT / filename).read_text(encoding="utf-8"))
                partition = tool.inspect_partition(table.to_binary().ljust(tool.PAGE, b"\xff"),
                                                   self.sdk, capacity, 0x8000)
                self.assertEqual((partition.offset, partition.size), (0x9000, 0x10000))
                output = io.BytesIO()
                with gen.NVS(output, partition.size - tool.PAGE, gen.Page.VERSION2) as nvs:
                    nvs.write_namespace("kb_identity")
                    nvs.write_entry("version", "1", "u32")
                    nvs.write_entry("device_id", "123456789abc", "string")
                    nvs.write_entry("ap_password", "p" * 24, "string")
                    nvs.write_entry("claim_salt", "aa" * 16, "hex2bin")
                    nvs.write_entry("claim_hash", "bb" * 32, "hex2bin")
                    nvs.write_entry("claim_cost", "100000", "u32")
                initial = output.getvalue()
                self.assertEqual(len(initial), partition.size)
                self.assertEqual(len(tool.RawNVS(initial).free), 15)
                populated = tool.Settings(True, b"fixture-host", tuple(
                    profile(str(i).encode()) for i in range(10)))
                result = tool.plan_update(initial, populated)[1]
                self.assertEqual(tool.RawNVS(result).settings(), populated)
                self.assertEqual(len(tool.RawNVS(result).free), 14)


if __name__ == "__main__":
    unittest.main()
