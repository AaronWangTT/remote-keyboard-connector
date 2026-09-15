import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { firmwareManifest, firmwareMetadata, firmwareSecurity, installOptions, loadFirmware, runInstaller } from "./install-device.mjs";
import { createIdentity, identityCsv, passwordIterations, wifiPayload, writeIdentity } from "./provision-device.mjs";

test("identity generation uses independent device-bound AP and claim credentials", () => {
  const first = createIdentity("001122aAbBcC");
  const second = createIdentity("001122aabbcc");
  assert.equal(first.deviceId, "001122aabbcc");
  assert.equal(first.ssid, "WiFiKeyboard-AABBCC");
  assert.notEqual(first.apPassword, second.apPassword);
  assert.notEqual(first.setupCode, first.apPassword);
  assert.notEqual(first.setupCode, second.setupCode);
  assert.equal(first.verifier, pbkdf2Sync(first.setupCode, Buffer.from(first.salt, "hex"), passwordIterations, 32, "sha256").toString("hex"));
  const csv = identityCsv(first);
  assert.ok(csv.includes("kb_identity,namespace,,\n"));
  assert.ok(csv.includes(`claim_hash,data,hex2bin,${first.verifier}\n`));
  assert.ok(!csv.includes(first.setupCode));
  assert.equal(wifiPayload(first), `WIFI:T:WPA;S:${first.ssid};P:${first.apPassword};;`);
  for (const invalid of ["", "00:11:22:33:44:55", "001122aabbc", "001122aabbc;", "001122aabbcc\n"]) {
    assert.throws(() => createIdentity(invalid));
  }
});

test("private setup files are outside Git, contain a PNG/card, and never overwrite", async context => {
  await assert.rejects(writeIdentity("001122334455", ".cache/not-private"));
  const temporary = await mkdtemp(join(tmpdir(), "keyboard-provision-test-"));
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const unexpectedParent = join(repository, basename(temporary));
  await assert.rejects(access(unexpectedParent), { code: "ENOENT" });
  try {
    const repositoryLink = join(temporary, "repository-link");
    await symlink(repository, repositoryLink, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(writeIdentity("001122334455", join(repositoryLink, basename(temporary), "nested", "device")),
      /must not resolve into the repository/);
    await assert.rejects(access(unexpectedParent), { code: "ENOENT" });
    const parent = join(temporary, "new-parent");
    const directory = join(parent, "device");
    await assert.rejects(writeIdentity("mistyped-MAC", directory));
    await assert.rejects(access(parent), { code: "ENOENT" });
    const generationFailure = context.mock.method(QRCode, "toBuffer", async () => { throw new Error("Injected QR failure"); });
    await assert.rejects(writeIdentity("001122334455", directory), /Injected QR failure/);
    await assert.rejects(access(directory), { code: "ENOENT" });
    generationFailure.mock.restore();
    const originalToBuffer = QRCode.toBuffer;
    const writeFailure = context.mock.method(QRCode, "toBuffer", async (...arguments_) => {
      const png = await originalToBuffer(...arguments_);
      await mkdir(join(directory, "wifi-qr.png"));
      return png;
    });
    await assert.rejects(writeIdentity("001122334455", directory));
    await assert.rejects(access(directory), { code: "ENOENT" });
    writeFailure.mock.restore();
    await writeIdentity("001122334455", directory);
    const before = await readFile(join(directory, "identity.csv"), "utf8");
    const card = await readFile(join(directory, "setup-card.html"), "utf8");
    const png = await readFile(join(directory, "wifi-qr.png"));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.ok(card.includes("data:image/png;base64,"));
    assert.ok(card.includes("http://kb.local/"));
    assert.ok(card.includes("WiFiKeyboard-334455"));
    await assert.rejects(writeIdentity("001122334455", directory), { code: "EEXIST" });
    assert.equal(await readFile(join(directory, "identity.csv"), "utf8"), before);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(unexpectedParent, { recursive: true, force: true });
  }
});

function firmwareFixture() {
  return {
    write_flash_args: ["--flash-mode", "dio", "--flash-size", "2MB", "--flash-freq", "80m"],
    flash_settings: { flash_mode: "dio", flash_size: "2MB", flash_freq: "80m" },
    flash_files: { "0x0": "bootloader/bootloader.bin", "0x8000": "partition_table/partition-table.bin", "0x10000": "app.bin" },
    bootloader: { offset: "0x0", file: "bootloader/bootloader.bin", encrypted: "false" },
    "partition-table": { offset: "0x8000", file: "partition_table/partition-table.bin", encrypted: "false" },
    app: { offset: "0x10000", file: "app.bin", encrypted: "false" },
    extra_esptool_args: { chip: "esp32s3" },
  };
}

const configurationFixture = { IDF_TARGET: "esp32s3", SECURE_BOOT: false, SECURE_FLASH_ENC_ENABLED: false,
  KEYBOARD_HTTP_DEVELOPMENT: true };

test("installer rejects bootloaders configured to provision security or burn rollback eFuses", () => {
  assert.equal(firmwareSecurity(configurationFixture).secureBoot, false);
  for (const setting of ["SECURE_BOOT", "SECURE_FLASH_ENC_ENABLED", "SECURE_BOOT_V2_ENABLED",
    "SECURE_BOOT_BUILD_SIGNED_BINARIES", "SECURE_SIGNED_APPS_NO_SECURE_BOOT", "BOOTLOADER_APP_ANTI_ROLLBACK"]) {
    assert.throws(() => firmwareSecurity({ ...configurationFixture, [setting]: true }));
  }
  const unsignedConfiguration = { ...configurationFixture, SECURE_SIGNED_APPS_NO_SECURE_BOOT: false,
    SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT: false };
  assert.equal(firmwareSecurity(unsignedConfiguration).signedApps, false);
  assert.throws(() => firmwareSecurity({ ...unsignedConfiguration, SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT: true }),
    /Unsupported security build configuration: SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT/);
  assert.throws(() => firmwareSecurity({ IDF_TARGET: "esp32s3" }));
});

test("installer requires the HTTP owner-claim UI in validated builds", () => {
  assert.equal(firmwareSecurity(configurationFixture).httpDevelopment, true);
  for (const setting of [undefined, false, "true", 1]) {
    assert.throws(() => firmwareSecurity({ ...configurationFixture, KEYBOARD_HTTP_DEVELOPMENT: setting }),
      /HTTP.*owner-claim/);
  }
});

test("installer accepts sparse firmware metadata and rejects unsafe inputs", () => {
  const accepted = firmwareMetadata(firmwareFixture());
  assert.equal(accepted.flashBytes, 2097152);
  assert.deepEqual(accepted.images.map(image => image.offset), [0, 0x8000, 0x10000]);
  for (const change of [
    flash => { flash.extra_esptool_args.chip = "esp32"; },
    flash => { flash.app.encrypted = "true"; },
    flash => { delete flash.flash_files["0x10000"]; },
    flash => { flash.flash_files["0x9000"] = "identity.bin"; },
    flash => { flash.app.offset = "0x10001"; },
    flash => { flash.app.file = "../outside.bin"; flash.flash_files["0x10000"] = flash.app.file; },
    flash => { flash.flash_settings.flash_size = "detect"; },
    flash => { flash.write_flash_args[1] = "qio"; },
    flash => { flash.write_flash_args.push("--force"); },
  ]) {
    const flash = firmwareFixture();
    change(flash);
    assert.throws(() => firmwareMetadata(flash));
  }
});

test("installer verifies every firmware file before a device operation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "keyboard-firmware-test-"));
  try {
    const flash = firmwareFixture();
    await writeFile(join(temporary, "flasher_args.json"), JSON.stringify(flash));
    await mkdir(join(temporary, "config"));
    await writeFile(join(temporary, "config/sdkconfig.json"), JSON.stringify(configurationFixture));
    for (const path of Object.values(flash.flash_files)) {
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await writeFile(join(temporary, path), Buffer.alloc(256, 0xff));
    }
    const firmware = await loadFirmware(temporary);
    assert.equal(firmware.images.length, 3);
    assert.ok(firmware.images.every(image => image.bytes === 256 && /^[0-9a-f]{64}$/.test(image.sha256)));
    const manifest = firmwareManifest(firmware);
    assert.equal(manifest.formatVersion, 2);
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await rm(join(temporary, "config"), { recursive: true });
    assert.equal((await loadFirmware(temporary)).security.flashEncryption, false);
    manifest.formatVersion = 1;
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadFirmware(temporary), /manifest/);
    manifest.formatVersion = 2;
    delete manifest.security.httpDevelopment;
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadFirmware(temporary), /manifest/);
    manifest.security.httpDevelopment = false;
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadFirmware(temporary), /manifest/);
    manifest.security.httpDevelopment = true;
    manifest.security.secureBoot = true;
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadFirmware(temporary), /manifest/);
    manifest.security.secureBoot = false;
    manifest.images[0].sha256 = "0".repeat(64);
    await writeFile(join(temporary, "firmware-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadFirmware(temporary), /manifest/);
    await rm(join(temporary, "firmware-manifest.json"));
    await assert.rejects(loadFirmware(temporary), { code: "ENOENT" });
    await writeFile(join(temporary, "bootloader/bootloader.bin"), Buffer.alloc(0x8001));
    await assert.rejects(loadFirmware(temporary), /Overlapping/);
    await writeFile(join(temporary, "bootloader/bootloader.bin"), Buffer.alloc(0));
    await assert.rejects(loadFirmware(temporary), /Empty image/);
    await rm(join(temporary, "bootloader/bootloader.bin"));
    await assert.rejects(loadFirmware(temporary), { code: "ENOENT" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installer CLI requires explicit execution, device identity, and private output", () => {
  assert.deepEqual(installOptions(["--help"], {}), { help: true });
  assert.throws(() => installOptions([], {}), /ESP-IDF terminal/);
  const environment = { IDF_PATH: "sdk" };
  for (const args of [["--execute"], ["--replace-nvs"], ["--baud", "0"], ["--force"],
    ["--execute", "--device-id", "00:11:22:33:44:55", "--output", "private", "--port", "MOCK"]]) {
    assert.throws(() => installOptions(args, environment));
  }
  const options = installOptions(["--execute", "--device-id", "001122AABBCC", "--output", "private", "--port", "MOCK"], environment);
  assert.equal(options.deviceId, "001122aabbcc");
  assert.equal(options.execute, true);
  assert.equal(options.replaceNvs, false);
});

test("installer defaults to offline checks and installs from an immutable private snapshot", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "keyboard-install-command-test-"));
  try {
    const flash = firmwareFixture();
    const source = join(temporary, "source");
    await mkdir(source);
    await writeFile(join(source, "flasher_args.json"), JSON.stringify(flash));
    await mkdir(join(source, "config"));
    await writeFile(join(source, "config/sdkconfig.json"), JSON.stringify(configurationFixture));
    for (const path of Object.values(flash.flash_files)) {
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), Buffer.alloc(256, 0xff));
    }
    const calls = [];
    const logs = [];
    const options = ["--firmware", source, "--idf-path", "sdk"];
    const dependencies = { log: message => logs.push(message), sdk: async (operation, request) => {
      calls.push({ operation, request });
      return operation === "inspect" ? { nvs: { offset: 0x9000, size: 0x6000 } } : { verified: true };
    } };
    assert.equal((await runInstaller(options, { ...dependencies, writeIdentity: () => {
      throw new Error("Offline check must not generate credentials");
    } })).mode, "check");
    assert.deepEqual(calls.map(call => call.operation), ["inspect"]);
    const output = join(temporary, "private");
    const result = await runInstaller([...options, "--execute", "--device-id", "001122334455", "--port", "MOCK", "--output", output], dependencies);
    assert.equal(result.mode, "install");
    assert.deepEqual(calls.map(call => call.operation), ["inspect", "inspect", "install"]);
    assert.equal(calls[2].request.execute, true);
    assert.equal(calls[2].request.replaceNvs, false);
    assert.equal(calls[2].request.firmware.root, await realpath(join(output, "firmware")));
    const csv = await readFile(join(output, "identity.csv"), "utf8");
    assert.equal(calls[2].request.directory, join(output, "installation"));
    assert.equal(calls[2].request.identityCsv, csv);
    await assert.rejects(access(calls[2].request.directory), { code: "ENOENT" });
    const password = csv.split("\n").find(line => line.startsWith("ap_password,")).split(",")[3];
    assert.ok(!logs.join("\n").includes(password));
    await writeFile(join(source, "app.bin"), "changed build");
    assert.equal((await readFile(join(output, "firmware/app.bin"))).length, 256);
    await assert.rejects(runInstaller([...options, "--execute", "--device-id", "001122334455", "--port", "MOCK", "--output", output], dependencies), { code: "EEXIST" });
    assert.equal(calls.filter(call => call.operation === "install").length, 1);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});