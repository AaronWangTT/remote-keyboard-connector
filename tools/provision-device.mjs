import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

export const passwordIterations = 100000;
const root = fileURLToPath(new URL("../", import.meta.url));

export function createIdentity(deviceId) {
  assert.match(deviceId, /^[0-9a-f]{12}$/i, "Use the board's twelve-digit factory base MAC without separators");
  const identity = {
    version: 1,
    deviceId: deviceId.toLowerCase(),
    apPassword: randomBytes(18).toString("base64url"),
    setupCode: randomBytes(12).toString("hex"),
    salt: randomBytes(16).toString("hex"),
    iterations: passwordIterations,
  };
  identity.ssid = `WiFiKeyboard-${identity.deviceId.slice(-6).toUpperCase()}`;
  identity.verifier = pbkdf2Sync(identity.setupCode, Buffer.from(identity.salt, "hex"),
    identity.iterations, 32, "sha256").toString("hex");
  return identity;
}

export function identityCsv(identity) {
  assert.match(identity.deviceId, /^[0-9a-f]{12}$/);
  assert.match(identity.apPassword, /^[A-Za-z0-9_-]{24}$/);
  assert.match(identity.salt, /^[0-9a-f]{32}$/);
  assert.match(identity.verifier, /^[0-9a-f]{64}$/);
  assert.equal(identity.iterations, passwordIterations);
  return ["key,type,encoding,value", "kb_identity,namespace,,",
    `version,data,u32,${identity.version}`, `device_id,data,string,${identity.deviceId}`,
    `ap_password,data,string,${identity.apPassword}`, `claim_salt,data,hex2bin,${identity.salt}`,
    `claim_hash,data,hex2bin,${identity.verifier}`, `claim_cost,data,u32,${identity.iterations}`, ""].join("\n");
}

export function wifiPayload(identity) {
  const escape = value => value.replace(/[\\;,:\"]/g, character => `\\${character}`);
  return `WIFI:T:WPA;S:${escape(identity.ssid)};P:${escape(identity.apPassword)};;`;
}

function outsideRepository(directory) {
  const contained = relative(root, directory);
  return isAbsolute(contained) || contained === ".." || contained.startsWith(`..${sep}`);
}

export async function writeIdentity(deviceId, output) {
  const directory = resolve(output);
  assert.ok(outsideRepository(directory), "Private provisioning output must be outside the repository");
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const parent = await realpath(dirname(directory));
  assert.ok(outsideRepository(parent), "Private output must not resolve into the repository");
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    assert.ok(process.env.USERDOMAIN && process.env.USERNAME, "Cannot identify the Windows account for private permissions");
    execFileSync("icacls.exe", [directory, "/inheritance:r", "/grant:r",
      `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`], { stdio: "pipe" });
  }
  const identity = createIdentity(deviceId);
  const png = await QRCode.toBuffer(wifiPayload(identity), { type: "png", errorCorrectionLevel: "M", margin: 4, width: 360 });
  const card = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Private Wi-Fi Keyboard Setup</title><style>
body{font-family:Verdana,sans-serif;max-width:620px;margin:32px auto;padding:24px;color:#172b29;line-height:1.6}
h1{font-size:26px}img{width:260px;height:260px;max-width:100%;object-fit:contain}dt{font-weight:bold}dd{margin:0 0 16px;overflow-wrap:anywhere}
code{font-size:16px}small{display:block;margin-top:24px} @media print{body{margin:0}}
</style></head><body><h1>Wi-Fi Keyboard</h1><p>Private setup card - keep for recovery.</p>
<img src="data:image/png;base64,${png.toString("base64")}" alt="Wi-Fi connection QR code">
<dl><dt>Wi-Fi network</dt><dd>${identity.ssid}</dd><dt>Wi-Fi password</dt><dd><code>${identity.apPassword}</code></dd>
<dt>Browser address</dt><dd>http://kb.local/ (AP fallback: http://192.168.4.1/)</dd>
<dt>One-time owner setup code</dt><dd><code>${identity.setupCode}</code></dd><dt>Device</dt><dd>${identity.deviceId}</dd></dl>
<p>Join the protected Wi-Fi, open the browser address, and choose your own owner password. The setup code stops working after ownership is claimed. The Wi-Fi password remains useful for AP operation and recovery.</p>
<small>HTTP/WS development firmware: use a protected, trusted test network. Application credentials and input are not protected against network interception. This card grants Wi-Fi access; keep it private.</small>
</body></html>\n`;
  await writeFile(resolve(directory, "identity.csv"), identityCsv(identity), { flag: "wx", mode: 0o600 });
  await writeFile(resolve(directory, "wifi-qr.png"), png, { flag: "wx", mode: 0o600 });
  await writeFile(resolve(directory, "setup-card.html"), card, { flag: "wx", mode: 0o600 });
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [deviceFlag, deviceId, outputFlag, output, ...extra] = process.argv.slice(2);
  assert.ok(deviceFlag === "--device-id" && outputFlag === "--output" && output && extra.length === 0,
    "Usage: node tools/provision-device.mjs --device-id <factory-base-MAC> --output <new-private-directory-outside-repo>");
  const directory = await writeIdentity(deviceId, output);
  console.log(`Private setup files prepared in ${directory}`);
  console.log("No secrets printed. No serial connection, NVS write, flash erase, or device operation performed.");
  console.log("An NVS image replaces partition contents; verify the board and partition layout before a separate sender-side provisioning step.");
}