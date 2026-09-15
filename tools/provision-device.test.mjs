import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("private setup files are outside Git, contain a PNG/card, and never overwrite", async () => {
  await assert.rejects(writeIdentity("001122334455", ".cache/not-private"));
  const temporary = await mkdtemp(join(tmpdir(), "keyboard-provision-test-"));
  try {
    const parent = join(temporary, "new-parent");
    const directory = join(parent, "device");
    await assert.rejects(writeIdentity("mistyped-MAC", directory));
    await assert.rejects(access(parent), { code: "ENOENT" });
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
  }
});