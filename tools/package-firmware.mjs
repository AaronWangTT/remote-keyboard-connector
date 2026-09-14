import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = resolve(root, process.argv[2] ?? "build");
const python = process.env.PYTHON ?? "python3";
const digest = contents => createHash("sha256").update(contents).digest("hex");
const jsonFile = async path => JSON.parse(await readFile(path, "utf8"));
const flash = await jsonFile(join(build, "flasher_args.json"));
const project = await jsonFile(join(build, "project_description.json"));
const configuration = await jsonFile(join(build, "config/sdkconfig.json"));

assert.equal(project.target, "esp32s3", "Only the ESP32-S3 keyboard build is supported");
assert.equal(flash.extra_esptool_args?.chip, project.target, "Flash target does not match the build");
assert.ok(!configuration.SECURE_BOOT && !configuration.SECURE_BOOT_V2_ENABLED &&
          !configuration.SECURE_FLASH_ENC_ENABLED, "Secure/encrypted firmware needs a separate flashing workflow");
assert.ok(Array.isArray(flash.write_flash_args) && flash.write_flash_args.length > 0);
assert.ok(flash.write_flash_args.every(argument => typeof argument === "string" && /^[\w.-]+$/.test(argument)),
          "Unsupported flash argument format");
assert.ok(flash.flash_files && Object.keys(flash.flash_files).length > 0, "No flash images found");

const images = Object.entries(flash.flash_files).map(([offset, path]) => {
  assert.match(offset, /^0x[0-9a-f]+$/i, "Invalid image offset");
  assert.equal(typeof path, "string");
  assert.ok(!isAbsolute(path) && !path.includes("\\") && !/[\r\n\"]/.test(path), "Invalid image path");
  const source = resolve(build, path);
  const contained = relative(build, source);
  assert.ok(contained !== ".." && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
            "Image path escapes the build directory");
  return { offset, path, source };
}).sort((left, right) => Number(left.offset) - Number(right.offset));

for (const role of ["bootloader", "partition-table", "app"]) {
  const image = flash[role];
  assert.ok(image && image.encrypted === "false", `Missing or encrypted ${role} image`);
  assert.equal(flash.flash_files[image.offset], image.file, `Inconsistent ${role} flash metadata`);
}
assert.equal(flash.app.file, project.app_bin, "Application image does not match the project");

const capacity = /^(\d+)(KB|MB)$/.exec(flash.flash_settings?.flash_size ?? "");
assert.ok(capacity, "A fixed build flash size is required for packaging");
const flashBytes = Number(capacity[1]) * (capacity[2] === "MB" ? 1048576 : 1024);
let previousEnd = 0;
const contents = new Map();
for (const image of images) {
  const data = await readFile(image.source);
  const offset = Number(image.offset);
  assert.ok(data.length > 0, `Empty image: ${image.path}`);
  assert.ok(offset % 4096 === 0, `Image offset is not sector-aligned: ${image.path}`);
  assert.ok(offset >= previousEnd && offset + data.length <= flashBytes, `Overlapping or oversized image: ${image.path}`);
  previousEnd = offset + Math.ceil(data.length / 4096) * 4096;
  contents.set(image.path, data);
}

contents.set("flash_args", Buffer.from(`${flash.write_flash_args.join(" ")}\n${
  images.map(image => `${image.offset} ${JSON.stringify(image.path)}`).join("\n")}\n`));
contents.set("flasher_args.json", Buffer.from(`${JSON.stringify(flash, null, 2)}\n`));
contents.set("dependencies.lock", await readFile(join(root, "dependencies.lock")));
contents.set("FLASHING.md", await readFile(join(root, "docs/flashing-local.md")));
contents.set("licenses/lucide.txt", await readFile(join(root, "components/web_server/www/icons/LICENSE")));

const manifest = {
  format_version: 1,
  created_at: new Date().toISOString(),
  project: project.project_name,
  project_version: project.project_version,
  idf_revision: project.git_revision,
  chip: project.target,
  flash_settings: flash.flash_settings,
  psram_enabled: Boolean(configuration.SPIRAM),
  hardware_acceptance: "pending",
  ap_password: configuration.MINIMAL_AP_PASSWORD === "a-key-test-only"
    ? "a-key-test-only (public development default)" : "custom build setting; not included in this manifest",
  files: [...contents].map(([path, data]) => ({
    path,
    bytes: data.length,
    sha256: digest(data),
    ...(images.some(image => image.path === path) ? { offset: images.find(image => image.path === path).offset } : {}),
  })),
};
contents.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
contents.set("SHA256SUMS.txt", Buffer.from([...contents].map(([path, data]) => `${digest(data)}  ${path}`).join("\n") + "\n"));

const staging = await mkdtemp(join(build, ".flash-package-"));
const folderName = "wifi-keyboard-esp32s3";
try {
  for (const [path, data] of contents) {
    const destination = join(staging, folderName, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  const archive = join(staging, "firmware-package.zip");
  execFileSync(python, ["-m", "zipfile", "-c", archive, folderName], { cwd: staging, stdio: "inherit" });
  const extracted = join(staging, "verified");
  execFileSync(python, ["-m", "zipfile", "-e", archive, extracted], { stdio: "inherit" });
  for (const [path, data] of contents) {
    assert.equal(digest(await readFile(join(extracted, folderName, path))), digest(data), `Archive verification failed: ${path}`);
  }
  const output = join(build, "firmware-package.zip");
  const archiveDigest = digest(await readFile(archive));
  await copyFile(archive, output);
  await writeFile(`${output}.sha256`, `${archiveDigest}  firmware-package.zip\n`);
  console.log(`Verified ${contents.size} archived files against their sources.`);
  console.log(`Firmware ZIP: ${output}`);
  console.log(`Archive SHA-256: ${archiveDigest}`);
  console.log(`Settings: ${project.target}, ${flash.flash_settings.flash_size}, ${flash.flash_settings.flash_mode}, ${flash.flash_settings.flash_freq}`);
  for (const image of manifest.files.filter(file => file.offset !== undefined)) {
    console.log(`${image.offset}  ${image.path}  ${image.bytes} bytes  ${image.sha256}`);
  }
  console.log("Packaging only: no serial connection, flash write, erase, or eFuse operation was performed.");
} finally {
  await rm(staging, { recursive: true, force: true });
}