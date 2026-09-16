import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sdkHelper = fileURLToPath(new URL("install_device.py", import.meta.url));
const supportedSecurity = { secureBoot: false, flashEncryption: false, signedApps: false, antiRollback: false,
  httpDevelopment: true };
const otaSecurity = { ...supportedSecurity, signedApps: true };

export function firmwareSecurity(configuration) {
  assert.equal(configuration.IDF_TARGET, "esp32s3", "Build configuration targets another chip");
  assert.equal(configuration.SECURE_BOOT, false, "Secure-boot provisioning requires a separate installer");
  assert.equal(configuration.SECURE_FLASH_ENC_ENABLED, false, "Flash-encryption provisioning requires a separate installer");
  assert.equal(configuration.KEYBOARD_HTTP_DEVELOPMENT, true, "Firmware must enable the HTTP owner-claim UI");
  if (configuration.SECURE_SIGNED_APPS_NO_SECURE_BOOT === true) {
    for (const name of ["SECURE_SIGNED_APPS_RSA_SCHEME", "SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT",
      "SECURE_BOOT_BUILD_SIGNED_BINARIES", "BOOTLOADER_APP_ROLLBACK_ENABLE", "BOOTLOADER_WDT_ENABLE",
      "BOOTLOADER_WDT_DISABLE_IN_USER_CODE"]) assert.equal(configuration[name], true, `Missing OTA setting: ${name}`);
    assert.equal(configuration.ESPTOOLPY_FLASHSIZE, "16MB");
    for (const name of ["SECURE_BOOT_V2_ENABLED", "BOOTLOADER_APP_ANTI_ROLLBACK", "ESP_PHY_INIT_DATA_IN_PARTITION"]) {
      assert.ok(!configuration[name], `Unsupported OTA setting: ${name}`);
    }
    return { ...otaSecurity };
  }
  for (const setting of ["SECURE_BOOT_V2_ENABLED", "SECURE_BOOT_BUILD_SIGNED_BINARIES",
    "SECURE_SIGNED_APPS_NO_SECURE_BOOT", "SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT", "BOOTLOADER_APP_ANTI_ROLLBACK"]) {
    assert.ok(configuration[setting] === undefined || configuration[setting] === false,
      `Unsupported security build configuration: ${setting}`);
  }
  return { ...supportedSecurity };
}

export function firmwareManifest(firmware) {
  if (firmware.security.signedApps) return firmware.manifest;
  return { formatVersion: 2, target: "esp32s3", security: { ...supportedSecurity },
    settings: firmware.settings, flashBytes: firmware.flashBytes,
    images: firmware.images.map(({ role, path, offset, bytes, sha256 }) => ({ role, path, offset, bytes, sha256 })) };
}

export function firmwareMetadata(flash) {
  assert.equal(flash.extra_esptool_args?.chip, "esp32s3", "Only ESP32-S3 firmware is supported");
  const settings = flash.flash_settings;
  const ota = Object.hasOwn(flash, "otadata");
  const roles = ota ? ["bootloader", "partition-table", "otadata", "app"] : ["bootloader", "partition-table", "app"];
  assert.ok(settings && ["dio", "dout", "qio", "qout"].includes(settings.flash_mode), "Invalid flash mode");
  assert.ok(["20m", "26m", "40m", "80m"].includes(settings.flash_freq), "Unsupported flash frequency");
  if (ota) assert.deepEqual(settings, { flash_mode: "dio", flash_size: "keep", flash_freq: "80m" }, "Invalid signed OTA flash settings");
  else assert.match(settings.flash_size, /^(1|2|4|8|16|32)MB$/, "A fixed supported flash size is required");
  const writeFlashArgs = ["--flash-mode", settings.flash_mode, "--flash-freq", settings.flash_freq,
    "--flash-size", settings.flash_size];
  assert.ok(Array.isArray(flash.write_flash_args) && flash.write_flash_args.length === writeFlashArgs.length,
    "Unexpected flash arguments");
  const argumentsByName = new Map();
  for (let index = 0; index < flash.write_flash_args.length; index += 2) {
    argumentsByName.set(flash.write_flash_args[index], flash.write_flash_args[index + 1]);
  }
  assert.equal(argumentsByName.size, 3, "Duplicate flash arguments");
  for (let index = 0; index < writeFlashArgs.length; index += 2) {
    assert.equal(argumentsByName.get(writeFlashArgs[index]), writeFlashArgs[index + 1], "Inconsistent flash settings");
  }
  assert.ok(flash.flash_files && Object.keys(flash.flash_files).length === roles.length,
    "Unexpected firmware image roles; no NVS or extra images allowed");
  const images = roles.map(role => {
    const image = flash[role];
    assert.ok(image && image.encrypted === "false", `Missing or encrypted ${role} image`);
    assert.match(image.offset, /^0x[0-9a-f]+$/i, "Invalid image offset");
    assert.equal(typeof image.file, "string", "Invalid image path");
    assert.ok(image.file.length > 0 && !isAbsolute(image.file) &&
      !image.file.split("/").some(part => part === ".." || part === "." || part === "") &&
      !/[\\:\x00-\x1f\x7f]/.test(image.file), "Unsafe image path");
    assert.equal(flash.flash_files[image.offset], image.file, "Inconsistent image metadata");
    const offset = Number(image.offset);
    assert.ok(Number.isSafeInteger(offset) && offset % 4096 === 0, "Image offset must be sector-aligned");
    return { role, path: image.file, offset };
  }).sort((left, right) => left.offset - right.offset);
  assert.equal(new Set(images.map(image => image.offset)).size, roles.length, "Duplicate image offsets");
  assert.equal(new Set(images.map(image => image.path)).size, roles.length, "Duplicate image paths");
  assert.equal(images[0].role, "bootloader", "Bootloader must be the first image");
  assert.equal(images[0].offset, 0, "ESP32-S3 bootloader must start at zero");
  return { settings: { flash_mode: settings.flash_mode, flash_size: settings.flash_size, flash_freq: settings.flash_freq },
    flashBytes: ota ? 0x1000000 : Number.parseInt(settings.flash_size, 10) * 1048576,
    writeFlashArgs, images };
}

export async function loadFirmware(directory) {
  const root = await realpath(resolve(directory));
  const flash = JSON.parse(await readFile(join(root, "flasher_args.json"), "utf8"));
  const metadata = firmwareMetadata(flash);
  let previousEnd = 0;
  const images = [];
  for (const image of metadata.images) {
    const source = await realpath(resolve(root, image.path));
    const contained = relative(root, source);
    assert.ok(contained !== ".." && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
      "Image resolves outside the firmware directory");
    const data = await readFile(source);
    assert.ok(data.length > 0, `Empty image: ${image.path}`);
    const end = image.offset + Math.ceil(data.length / 4096) * 4096;
    assert.ok(image.offset >= previousEnd && end <= metadata.flashBytes,
      `Overlapping or oversized image: ${image.path}`);
    previousEnd = end;
    images.push({ ...image, source, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  const firmware = { ...metadata, root, images, security: { ...supportedSecurity } };
  if (Object.hasOwn(flash, "otadata")) {
    const manifest = JSON.parse(await readFile(join(root, "firmware-manifest.json"), "utf8"));
    const signature = await readFile(join(root, "firmware-manifest.sig"));
    assert.equal(manifest.formatVersion, 3, "Unsupported OTA manifest schema");
    assert.equal(manifest.artifact, "keyboard-install");
    assert.equal(manifest.target, "esp32s3");
    assert.deepEqual(manifest.security, otaSecurity);
    assert.deepEqual(manifest.settings, metadata.settings);
    assert.equal(manifest.flashBytes, metadata.flashBytes);
    assert.deepEqual(manifest.images, images.map(({ role, path, offset, bytes, sha256 }) => ({ role, path, offset, bytes, sha256 })));
    assert.equal(signature.length, 384, "Invalid RSA-3072 manifest signature length");
    return { ...firmware, security: { ...otaSecurity }, manifest, manifestSignature: signature.toString("hex") };
  }
  let configuration;
  try {
    configuration = await readFile(join(root, "config/sdkconfig.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (configuration !== undefined) {
    firmware.security = firmwareSecurity(JSON.parse(configuration));
  } else {
    const manifest = JSON.parse(await readFile(join(root, "firmware-manifest.json"), "utf8"));
    assert.deepEqual(manifest, firmwareManifest(firmware), "Firmware manifest is unsafe or does not match the images and settings");
  }
  return firmware;
}

export function installOptions(args, environment = process.env) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    firmware: { type: "string", default: join(projectRoot, "build") },
    "idf-path": { type: "string", default: environment.IDF_PATH },
    python: { type: "string", default: environment.PYTHON || "python" },
    "device-id": { type: "string" },
    output: { type: "string" },
    port: { type: "string" },
    baud: { type: "string", default: "460800" },
    execute: { type: "boolean", default: false },
    "write-manifest": { type: "boolean", default: false },
    "replace-nvs": { type: "boolean", default: false },
    "reset-layout": { type: "boolean", default: false },
    "verification-key": { type: "string" },
    "allow-test-firmware": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  } });
  if (values.help) return { help: true };
  assert.ok(values["idf-path"], "Open an ESP-IDF terminal or supply --idf-path and --python");
  assert.ok(["115200", "230400", "460800", "921600"].includes(values.baud), "Unsupported serial baud rate");
  assert.ok(!values["replace-nvs"] || values.execute, "--replace-nvs requires --execute");
  assert.ok(!values["reset-layout"] || values.execute, "--reset-layout requires --execute");
  assert.ok(!(values["reset-layout"] && values["replace-nvs"]), "Choose full layout reset or legacy NVS replacement, not both");
  assert.ok(!values["write-manifest"] || !values.execute, "--write-manifest is an offline build operation");
  if (values.execute) {
    assert.match(values["device-id"] ?? "", /^[0-9a-f]{12}$/i, "--execute requires --device-id: twelve factory base MAC hex digits");
    assert.ok(values.output, "--execute requires a new private --output directory outside the repository");
    assert.ok(values.port && !values.port.includes("://"), "--execute requires an explicit local --port");
  }
  return { firmware: resolve(values.firmware), idfPath: resolve(values["idf-path"]), python: values.python,
    deviceId: values["device-id"]?.toLowerCase(), output: values.output && resolve(values.output),
    port: values.port, baud: Number(values.baud), execute: values.execute, replaceNvs: values["replace-nvs"],
    writeManifest: values["write-manifest"], resetLayout: values["reset-layout"],
    verificationKey: values["verification-key"] && resolve(values["verification-key"]),
    allowTestFirmware: values["allow-test-firmware"] };
}

function runSdk(options, operation, request) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(options.python, [sdkHelper, operation], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { process.stderr.write(chunk); });
    child.on("error", reject);
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`ESP-IDF ${operation} failed; review the diagnostic above. No automatic retry was attempted.`));
        return;
      }
      try {
        resolveResult(JSON.parse(output));
      } catch {
        reject(new Error("ESP-IDF helper returned an invalid result; do not assume the installation succeeded"));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function syncPrivateDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await syncPrivateDirectory(path);
    } else {
      assert.ok(entry.isFile(), "Private installation output must not contain symlinks or special files");
      const file = await open(path, "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
}

async function snapshotFirmware(firmware, directory) {
  const destination = join(directory, "firmware");
  await mkdir(destination, { mode: 0o700 });
  await copyFile(join(firmware.root, "flasher_args.json"), join(destination, "flasher_args.json"), constants.COPYFILE_EXCL);
  for (const image of firmware.images) {
    const target = join(destination, image.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(image.source, target, constants.COPYFILE_EXCL);
  }
  await writeFile(join(destination, "firmware-manifest.json"), `${JSON.stringify(firmwareManifest(firmware), null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  if (firmware.security.signedApps) {
    await writeFile(join(destination, "firmware-manifest.sig"), Buffer.from(firmware.manifestSignature, "hex"), { flag: "wx", mode: 0o600 });
  }
  const snapshot = await loadFirmware(destination);
  assert.deepEqual(snapshot.settings, firmware.settings, "Flash settings changed while creating the private package");
  const fingerprint = images => images.map(({ source, ...image }) => image);
  assert.deepEqual(fingerprint(snapshot.images), fingerprint(firmware.images), "Firmware changed while creating the private package");
  const args = [snapshot.writeFlashArgs.join(" "),
    ...snapshot.images.map(image => `0x${image.offset.toString(16)} ${JSON.stringify(image.path)}`), ""].join("\n");
  await writeFile(join(destination, "flash_args"), args, { flag: "wx", mode: 0o600 });
  return snapshot;
}

export async function runInstaller(args, dependencies = {}) {
  const options = installOptions(args);
  const log = dependencies.log ?? console.log;
  if (options.help) {
    log(`Usage: node tools/install-device.mjs [--firmware <build-or-extracted-artifact-directory>]
       [--idf-path <ESP-IDF-directory>] [--python <ESP-IDF-python>]

Without --execute: validate firmware and display its NVS layout offline. No secrets or device operations.
--write-manifest records a credential-free build manifest for distributing separate firmware images.
To install: add --execute --port <COMx> --device-id <12-hex-factory-base-MAC> --output <new-private-directory>
Optional: --baud <115200|230400|460800|921600> (default 460800).
--replace-nvs explicitly discards existing NVS settings and ownership after a verified full-flash backup.
OTA builds: --verification-key <independently trusted public PEM> is required, including offline checks.
To install an OTA build: also pass --reset-layout to confirm a full erase and fresh provisioning.
--allow-test-firmware explicitly permits installation of a test-key build. Never use a candidate bundle as its own trust root.
Legacy installations retain their existing partition guards; OTA clean installation never reads/converts old settings.
Private output includes a firmware snapshot, fresh identity, setup card, and installation verification records.
Only legacy factory installations include a full-flash backup. OTA --reset-layout creates no old-flash backup.
Never upload private output to Git or CI.`);
    return { mode: "help" };
  }
  const sdk = dependencies.sdk ?? ((operation, request) => runSdk(options, operation, request));
  const firmware = await loadFirmware(options.firmware);
  let verificationKey;
  if (firmware.security.signedApps) {
    assert.ok(options.verificationKey, "OTA verification requires an independently trusted --verification-key public PEM");
    verificationKey = await readFile(options.verificationKey, "utf8");
    assert.ok(/-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(verificationKey) && !verificationKey.includes("PRIVATE KEY"),
      "Supply a public verification key, not a private signing key");
    if (options.execute) {
      assert.ok(options.resetLayout, "OTA installation requires --reset-layout: full erase and fresh provisioning");
      const keyLocation = relative(firmware.root, await realpath(options.verificationKey));
      assert.ok(keyLocation === ".." || keyLocation.startsWith(`..${sep}`) || isAbsolute(keyLocation),
        "The trusted verification key must be obtained independently, outside the candidate firmware directory");
    }
  } else assert.ok(!options.resetLayout, "Layout reset requires a validated OTA build");
  const plan = await sdk("inspect", { firmware, idfPath: options.idfPath, verificationKey });
  log(`Validated ESP32-S3 firmware: ${firmware.settings.flash_size}, ${firmware.settings.flash_mode}, ${firmware.settings.flash_freq}.`);
  for (const image of firmware.images) log(`0x${image.offset.toString(16)}  ${image.path}  ${image.bytes} bytes`);
  log(`NVS identity: offset 0x${plan.nvs.offset.toString(16)}, size 0x${plan.nvs.size.toString(16)} (from the partition table).`);
  if (!options.execute) {
    if (options.writeManifest) {
      await writeFile(join(firmware.root, "firmware-manifest.json"), `${JSON.stringify(firmwareManifest(firmware), null, 2)}\n`);
      log("Wrote firmware-manifest.json with image SHA-256 hashes and supported build-security settings. No credentials included.");
    }
    log("Offline check only. No credentials generated, serial connection, flash write, erase, or eFuse operation.");
    return { mode: "check", plan };
  }
  if (options.replaceNvs) log("NVS replacement requested: existing Wi-Fi settings and ownership will be discarded after backup.");
  if (options.resetLayout) log("Full layout reset requested: the board will be erased and provisioned with new credentials.");
  const prepareIdentity = dependencies.writeIdentity ?? (await import("./provision-device.mjs")).writeIdentity;
  const directory = await prepareIdentity(options.deviceId, options.output, firmware.security.signedApps ? 10 : 100000);
  log(`Private installation files: ${directory}. Credentials are not printed.`);
  try {
    const snapshot = await snapshotFirmware(firmware, directory);
    await (dependencies.syncPrivateDirectory ?? syncPrivateDirectory)(directory);
    log(options.resetLayout ? "Checking the board before full erase and fresh installation." :
      "Checking the board and backing up flash before one combined firmware and NVS write.");
    const result = await sdk("install", { firmware: snapshot, idfPath: options.idfPath,
      directory: join(directory, "installation"), identityCsv: await readFile(join(directory, "identity.csv"), "utf8"),
      deviceId: options.deviceId, port: options.port, baud: options.baud, execute: true, replaceNvs: options.replaceNvs,
      resetLayout: options.resetLayout, verificationKey, allowTestFirmware: options.allowTestFirmware });
    assert.equal(result.verified, true, "The helper did not confirm write verification");
    log("Firmware and NVS verified on flash. Keep the private installation files and setup card; runtime acceptance is still required.");
    return { mode: "install", directory, result };
  } catch (error) {
    log("Installation stopped. Private files are retained; a write failure may leave partial firmware or NVS. Do not regenerate credentials to retry.");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runInstaller(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}