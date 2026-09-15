import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { WebSocket } from "ws";

async function startPreview(context, environment = {}) {
  const processHandle = fork(new URL("./preview.mjs", import.meta.url), {
    env: { ...process.env, PORT: "0", PREVIEW_USB_READY: "1", PREVIEW_CAPS_LOCK: "0", PREVIEW_OWNER_PASSWORD: "preview-owner-password", ...environment },
    silent: true,
  });
  const exited = once(processHandle, "exit");
  context.after(async () => {
    processHandle.kill("SIGTERM");
    await exited;
  });
  const [address] = await once(processHandle, "message", { signal: AbortSignal.timeout(5000) });
  assert.equal(address.type, "listening");
  return address.url;
}

async function loginRequest(url, password = "preview-owner-password") {
  const response = await fetch(new URL("/api/v1/session", url), {
    method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const state = await response.json();
  return { cookie: cookie.split(";")[0], csrf: state.csrf };
}

async function takeRequest(url, session) {
  const response = await fetch(new URL("/api/v1/control/take", url), {
    method: "POST", headers: { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf },
  });
  assert.equal(response.status, 200);
}

async function takeControl(page) {
  await expect(page.locator("#take-control")).toBeEnabled();
  await page.locator("#take-control").click();
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
}

test("network jobs are owner-only, bounded and preserve the last working profile", { timeout: 10000 }, async context => {
  const url = await startPreview(context, { PREVIEW_SCAN_TTL_MS: "1000" });
  const endpoint = new URL("/api/v1/network", url);
  assert.equal((await fetch(new URL("/api/v1/network/job", url))).status, 401);
  const session = await loginRequest(url);
  const headers = { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
  const submit = value => fetch(endpoint, { method: "POST", headers, body: JSON.stringify(value) });
  const status = async () => (await fetch(new URL("/api/v1/network/job", url), { headers })).json();
  const combined = await (await fetch(new URL("/api/v1/status", url), { headers })).json();
  assert.equal(combined.usb_ready, true);
  assert.equal(combined.network.hostname, "kb");
  assert.equal(combined.network.ap_active, true);
  assert.equal((await submit({ action: "cancel" })).status, 409);
  assert.equal((await submit({ action: "rename", hostname: "kb.local" })).status, 400);
  for (const fields of [{}, { ssid: 42 }, { ssid: "" }, { ssid: "valid\0ignored" }, { ssid_hex: 42 }, { ssid_hex: "zz" }, { ssid_hex: "00" },
    { ssid: "Home Wi-Fi", ssid_hex: "zz" }, { ssid: 42, ssid_hex: "486f6d65" }, { ssid: "Home", ssid_hex: "486f6d65" }]) {
    assert.equal((await submit({ action: "connect", ...fields, password: "test-router-password" })).status, 400);
  }
  for (const body of [
    '{"action":"connect","ssid":"A","password":"first-password","password":"last-password"}',
    '{"action":"connect","ssid":"A","password":"first-password","pass\\u0077ord":"last-password"}',
    '{"action":"ap",}', '{/*comment*/"action":"ap"}',
  ]) assert.equal((await fetch(endpoint, { method: "POST", headers, body })).status, 400);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { ...headers, "X-CSRF-Token": "bad" }, body: '{"action":"ap"}' })).status, 403);
  const scanEndpoint = new URL("/api/v1/network/scan", url);
  const beforeScan = await status();
  for (const body of [" ", "{}", "not-json", "x".repeat(2048)]) {
    assert.equal((await fetch(scanEndpoint, { method: "POST", headers, body })).status, 413);
  }
  const chunkedScan = httpRequest(scanEndpoint, { method: "POST", headers: { ...headers, "Transfer-Encoding": "chunked" } });
  const scanResponse = once(chunkedScan, "response");
  chunkedScan.write("unexpected");
  chunkedScan.end("body");
  const [rejectedScan] = await scanResponse;
  assert.equal(rejectedScan.statusCode, 413);
  rejectedScan.resume();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  context.after(() => agent.destroy());
  for (const [contentType, firstChunk] of [["text/plain", "not-json"], ["application/json", "x".repeat(2048)]]) {
    const rejectedRequest = httpRequest(endpoint, {
      method: "POST", agent, headers: { ...headers, "Content-Type": contentType, "Transfer-Encoding": "chunked" },
    });
    const rejectedResponse = once(rejectedRequest, "response");
    rejectedRequest.write(firstChunk);
    const [rejection] = await rejectedResponse;
    assert.equal(rejection.statusCode, 400);
    const originalSocket = rejectedRequest.socket;
    rejectedRequest.end("remaining-body");
    for await (const chunk of rejection) assert.ok(chunk.length > 0);
    const nextRequest = httpRequest(new URL("/api/v1/network/job", url), { agent, headers: { Cookie: session.cookie } });
    const nextResponse = once(nextRequest, "response");
    nextRequest.end();
    const [next] = await nextResponse;
    assert.equal(next.statusCode, 200);
    assert.equal(nextRequest.socket, originalSocket);
    const chunks = [];
    for await (const chunk of next) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), beforeScan);
  }
  for (const [rejectionHeaders, expectedStatus] of [
    [{ ...headers, Origin: "http://untrusted.invalid" }, 403],
    [{ ...headers, Cookie: "" }, 401],
    [{ ...headers, "X-CSRF-Token": "invalid" }, 403],
  ]) {
    const earlyRequest = httpRequest(endpoint, { method: "POST", agent,
      headers: { ...rejectionHeaders, "Content-Length": "8192" } });
    const earlyResponse = once(earlyRequest, "response");
    const closed = once(earlyRequest, "close");
    earlyRequest.flushHeaders();
    const [rejection] = await earlyResponse;
    assert.equal(rejection.statusCode, expectedStatus);
    assert.equal(rejection.headers.connection, "close");
    for await (const chunk of rejection) assert.ok(chunk.length > 0);
    await closed;
    const nextRequest = httpRequest(new URL("/api/v1/network/job", url), { agent, headers: { Cookie: session.cookie } });
    const nextResponse = once(nextRequest, "response");
    nextRequest.end();
    const [next] = await nextResponse;
    assert.equal(next.statusCode, 200);
    for await (const chunk of next) assert.ok(chunk.length > 0);
  }
  assert.deepEqual(await status(), beforeScan);
  assert.equal((await fetch(new URL("/api/v1/network/scan", url), { method: "POST", headers })).status, 202);
  await expect.poll(async () => (await status()).scan.length).toBe(5);
  await expect.poll(async () => (await status()).scan.length).toBe(0);
  assert.equal((await submit({ action: "connect", ssid_hex: "43616665ff", password: "test-router-password" })).status, 202);
  await expect.poll(status).toMatchObject({ job: "awaiting_confirmation", has_profile: true, saved_ssid: "Cafe\\xFF", saved_ssid_hex: "43616665ff" });
  assert.equal((await submit({ action: "cancel" })).status, 202);
  await takeRequest(url, session);
  assert.equal((await submit({ action: "ap" })).status, 409);
  await fetch(new URL("/api/v1/control/stop", url), { method: "POST", headers });
  assert.equal((await submit({ action: "connect", ssid_hex: "486f6d652057692d4669", password: "test-router-password" })).status, 202);
  assert.equal((await submit({ action: "rename", hostname: "kb-2" })).status, 409);
  await expect.poll(status).toMatchObject({ job: "awaiting_confirmation", station_online: true, ap_active: true, saved_ssid: "Home Wi-Fi" });
  assert.equal(JSON.stringify(await status()).includes("test-router-password"), false);
  assert.equal((await submit({ action: "confirm" })).status, 202);
  assert.equal((await submit({ action: "confirm" })).status, 409);
  await expect.poll(status).toMatchObject({ phase: "station", busy: false, ap_active: false });
  const idleStation = await status();
  assert.equal((await submit({ action: "cancel" })).status, 409);
  assert.deepEqual(await status(), idleStation);
  assert.equal((await submit({ action: "connect", ssid: "Other network", password: "wrong-password" })).status, 202);
  await expect.poll(status).toMatchObject({ job: "failed", error: "authentication_failed", ap_active: true, saved_ssid: "Home Wi-Fi" });
  assert.equal((await submit({ action: "ap" })).status, 202);
  await expect.poll(status).toMatchObject({ phase: "ap", desired_station: false, has_profile: true, busy: false });
  assert.equal((await submit({ action: "forget" })).status, 202);
  await expect.poll(status).toMatchObject({ saved_ssid: "", has_profile: false, ap_active: true, busy: false });
  assert.equal((await submit({ action: "connect", ssid: "literal\\u0000", password: "literal\\u0000" })).status, 202);
  await expect.poll(status).toMatchObject({ saved_ssid: "literal\\u0000", job: "awaiting_confirmation" });
});

test("abandoned handover becomes idle without another credential submission", { timeout: 10000 }, async context => {
  const url = await startPreview(context, { PREVIEW_CONFIRM_TTL_MS: "300" });
  const session = await loginRequest(url);
  const headers = { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
  const response = await fetch(new URL("/api/v1/network", url), {
    method: "POST", headers, body: JSON.stringify({ action: "connect", ssid: "Home Wi-Fi", password: "test-router-password" }),
  });
  assert.equal(response.status, 202);
  const status = async () => (await fetch(new URL("/api/v1/network/job", url), { headers })).json();
  await expect.poll(status).toMatchObject({ job: "awaiting_confirmation", busy: true, ap_active: true });
  await expect.poll(status, { intervals: [50] }).toMatchObject({ job: "succeeded", busy: false, ap_active: false, saved_ssid: "Home Wi-Fi" });
  const overlap = await fetch(new URL("/api/v1/network", url), {
    method: "POST", headers, body: JSON.stringify({ action: "connect", ssid: "overlap-network", password: "test-router-password" }),
  });
  assert.equal(overlap.status, 202);
  await expect.poll(status).toMatchObject({ job: "awaiting_ap_reconnect", busy: true, ap_reconnect_ip: "172.30.4.1" });
  await expect.poll(status, { intervals: [50] }).toMatchObject({ job: "failed", error: "confirmation_timeout", busy: false,
    ap_active: true, ap_ip: "192.168.4.1", ap_reconnect_ip: "", saved_ssid: "Home Wi-Fi" });
  await takeRequest(url, session);
});

async function signIn(page) {
  await page.getByLabel("Owner password", { exact: true }).fill("preview-owner-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await takeControl(page);
}

test("browser Network view scans, tests, confirms handover and forgets without USB input", { timeout: 30000 }, async context => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.goto(url);
  await signIn(page);
  await page.keyboard.down("a");
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await expect.poll(counters).toMatchObject({ pressed: true });
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await page.keyboard.up("a");
  await expect.poll(counters).toMatchObject({ pressed: false, connected: false });
  await expect(page.getByRole("heading", { name: "Network", exact: true })).toBeVisible();
  const before = (await counters()).down;
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  await page.getByRole("button", { name: "Scan networks", exact: true }).click();
  await expect(page.locator("#wifi-network")).toBeEnabled();
  await expect(page.locator("#wifi-network option")).toHaveCount(6);
  await page.locator("#wifi-network").selectOption("43616665ff");
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("Cafe\\xFF");
  await page.getByLabel("Wi-Fi password", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Test and Connect", exact: true }).click();
  await expect(page.locator("#network-job-status")).toHaveText("Wi-Fi authentication failed.");
  const office = page.locator("#wifi-network option", { hasText: "<Office & Guests>" });
  await page.locator("#wifi-network").selectOption(await office.getAttribute("value"));
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("<Office & Guests>");
  await expect(page.getByLabel("Wi-Fi password", { exact: true })).toHaveValue("");
  await page.getByLabel("Wi-Fi password", { exact: true }).fill("test-router-password");
  await page.getByRole("button", { name: "Test and Connect", exact: true }).click();
  await expect(page.locator("#network-station-address")).toHaveText("192.168.1.88");
  await expect(page.locator("#network-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Keep AP mode", exact: true }).click();
  await expect(page.getByLabel("Standalone AP", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("<Office & Guests>");
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  await expect(page.locator("#wifi-network option")).toHaveCount(6);
  await page.locator("#wifi-network").selectOption("43616665ff");
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("Cafe\\xFF");
  await page.getByRole("button", { name: "Connect saved network", exact: true }).click();
  await expect(page.locator("#network-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Switch to Wi-Fi", exact: true }).click();
  await expect(page.locator("#network-phase")).toHaveText("Connected to Wi-Fi");
  await page.getByLabel("Local hostname", { exact: true }).fill("kb-desk");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.locator("#network-name")).toHaveText("kb-desk.local");
  await page.locator("#forget-network").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator("#forget-dismiss").click();
  await expect(page.locator("#network-saved")).toHaveText("<Office & Guests>");
  await page.locator("#forget-network").click();
  await page.locator("#forget-confirm").click();
  await expect(page.locator("#network-saved")).toHaveText("None");
  await expect(page.locator("#network-phase")).toHaveText("Standalone AP");
  await expect(page.getByLabel("Standalone AP", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Use Standalone AP", exact: true })).toBeVisible();
  await expect(page.locator("#wifi-network option")).toHaveCount(6);
  assert.equal((await counters()).down, before);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.getByRole("button", { name: "Back to keyboard" }).click();
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeDisabled();
  await takeControl(page);
});

test("overlapping AP subnet is announced and confirmed before reconnecting at the new address", { timeout: 20000 }, async context => {
  const url = await startPreview(context, { PREVIEW_NETWORK_DELAY_MS: "1500" });
  const session = await loginRequest(url);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  let confirmations = 0;
  let retired = false;
  page.on("request", request => {
    if (request.method() === "POST" && request.postDataJSON()?.action === "confirm") confirmations++;
  });
  await page.context().route(/^http:\/\/(?:192\.168\.4\.1|172\.30\.4\.1)\//, async route => {
    const request = route.request();
    if (retired && new URL(request.url()).hostname === "192.168.4.1") { await route.abort("addressunreachable"); return; }
    const destination = new URL(new URL(request.url()).pathname, url);
    const headers = { ...request.headers(), host: destination.host };
    if (headers.origin) headers.origin = destination.origin;
    const response = await fetch(destination, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
    let body = Buffer.from(await response.arrayBuffer());
    if (response.status === 202) {
      const accepted = JSON.parse(body.toString());
      accepted.management_url = new URL("/", request.url()).href;
      body = Buffer.from(JSON.stringify(accepted));
      if (request.postDataJSON()?.action === "confirm") retired = true;
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
  });
  await page.goto("http://192.168.4.1/");
  await page.getByLabel("Owner password", { exact: true }).fill("preview-owner-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  await page.getByLabel("Network name (SSID)").fill("overlap-network");
  await page.getByLabel("Wi-Fi password", { exact: true }).fill("test-router-password");
  await page.getByRole("button", { name: "Test and Connect", exact: true }).click();
  await expect(page.getByRole("link", { name: "172.30.4.1", exact: true })).toHaveAttribute("href", "http://172.30.4.1/");
  await expect(page.locator("#network-ap-address")).toContainText("192.168.4.1");
  await expect(page.locator("#network-saved")).toHaveText("None");
  for (let poll = 0; poll < 3; poll++) {
    await page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/network/job");
    await expect(page.locator("#network-ap-address a")).toHaveCount(1);
    await expect(page.locator("#network-ap-address")).toHaveText("192.168.4.1 -> 172.30.4.1");
  }
  assert.equal(confirmations, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole("button", { name: "Change AP address", exact: true }).click();
  await expect(page.locator("#network-retry")).toBeVisible();
  await expect(page).toHaveURL("http://192.168.4.1/");
  const status = async () => (await fetch(new URL("/api/v1/network/job", url), { headers: { Cookie: session.cookie } })).json();
  await expect.poll(status).toMatchObject({ ap_ip: "172.30.4.1", job: "awaiting_confirmation" });
  const popup = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "172.30.4.1", exact: true }).click();
  const reconnected = await popup;
  await expect(reconnected).toHaveURL("http://172.30.4.1/");
  await expect(page).toHaveURL("http://192.168.4.1/");
  await reconnected.getByLabel("Owner password", { exact: true }).fill("preview-owner-password");
  await reconnected.getByRole("button", { name: "Sign in", exact: true }).click();
  await reconnected.getByRole("button", { name: "Network settings", exact: true }).click();
  await expect(reconnected.locator("#network-ap-address")).toHaveText("172.30.4.1");
  await expect(reconnected.locator("#network-saved")).toHaveText("overlap-network");
  await expect(reconnected.getByRole("button", { name: "Switch to Wi-Fi", exact: true })).toBeVisible();
  assert.equal(confirmations, 1);
  assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).down, 0);
});

test("hostname rename recovers through the numeric address when the old mDNS endpoint disappears", { timeout: 20000 }, async context => {
  const url = await startPreview(context);
  const oldAddress = new URL(url);
  oldAddress.hostname = "kb.local";
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  let retired = false;
  let renames = 0;
  await page.route(`${oldAddress.origin}/**`, async route => {
    if (retired) { await route.abort("namenotresolved"); return; }
    const request = route.request();
    const destination = new URL(new URL(request.url()).pathname, url);
    const headers = { ...request.headers(), host: destination.host };
    if (headers.origin) headers.origin = destination.origin;
    const response = await fetch(destination, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
    if (request.method() === "POST" && request.postDataJSON()?.action === "rename") {
      renames++;
      retired = true;
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(oldAddress.href);
  await page.getByLabel("Owner password", { exact: true }).fill("preview-owner-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await page.getByLabel("Local hostname", { exact: true }).fill("kb-desk");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page).toHaveURL(url);
  await page.getByLabel("Owner password", { exact: true }).fill("preview-owner-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await expect(page.locator("#network-name")).toHaveText("kb-desk.local");
  assert.equal(renames, 1);
  assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).down, 0);
});

test("lost network responses recover the existing job without resubmitting credentials", { timeout: 20000 }, async context => {
  const url = await startPreview(context, { PREVIEW_NETWORK_DELAY_MS: "1500" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await signIn(page);
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  await page.getByLabel("Network name (SSID)").fill("Home Wi-Fi");
  await page.getByLabel("Wi-Fi password", { exact: true }).fill("test-router-password");
  let submissions = 0;
  await page.route("**/api/v1/network", async route => {
    submissions++;
    if (submissions === 1) {
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Test and Connect", exact: true }).click();
  await expect(page.locator("#network-confirm")).toBeVisible();
  assert.equal(submissions, 1);
  await expect(page.getByLabel("Wi-Fi password", { exact: true })).toHaveValue("");
  await page.reload();
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await expect(page.locator("#network-confirm")).toBeVisible();
  assert.equal(submissions, 1);
  await page.getByRole("button", { name: "Keep AP mode", exact: true }).click();
  await expect(page.locator("#network-phase")).toHaveText("Standalone AP");
  await expect(page.locator("#network-saved")).toHaveText("Home Wi-Fi");
});

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${engineName} account and Network views fit mobile and desktop layouts`, { timeout: 20000 }, async context => {
    const url = await startPreview(context, { PREVIEW_CLAIMED: "0" });
    const browser = await engine.launch(engineName === "webkit" ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const screenshots = new URL("../.cache/tests/", import.meta.url);
    await mkdir(screenshots, { recursive: true });
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Claim keyboard" })).toBeVisible();
    const bounds = async () => page.evaluate(() => {
      const problems = [];
      for (const element of document.querySelectorAll("h1,h2,label,button,input,select,dd")) {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || getComputedStyle(element).opacity === "0") continue;
        if (box.left < 0 || box.right > innerWidth + 1) problems.push(`bounds:${element.id || element.tagName}`);
        if (["BUTTON", "H1", "H2", "DD"].includes(element.tagName) && element.scrollWidth > element.clientWidth + 1) problems.push(`text:${element.id || element.tagName}`);
      }
      return { problems, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    for (const [width, height] of [[320, 568], [568, 320], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      assert.deepEqual(await bounds(), { problems: [], overflow: false });
      if (width !== 568) await page.screenshot({ path: fileURLToPath(new URL(`claim-${engineName}-${width}.png`, screenshots)), fullPage: true });
    }
    await page.getByLabel("Owner setup code").fill("0123456789abcdef01234567");
    await page.getByLabel("Owner password", { exact: true }).fill("recipient-chosen-password");
    await page.getByLabel("Confirm owner password").fill("recipient-chosen-password");
    await page.getByRole("button", { name: "Claim keyboard", exact: true }).click();
    await page.getByRole("button", { name: "Network settings", exact: true }).click();
    await page.getByLabel("Join Wi-Fi", { exact: true }).check();
    await page.getByRole("button", { name: "Scan networks", exact: true }).click();
    await expect(page.locator("#wifi-network option")).toHaveCount(6);
    const longSsid = page.locator("#wifi-network option", { hasText: "A-very-long-network-name" });
    await page.locator("#wifi-network").selectOption(await longSsid.getAttribute("value"));
    for (const [width, height] of [[320, 568], [390, 844], [568, 320], [768, 1024], [1366, 768]]) {
      await page.setViewportSize({ width, height });
      const diagnostic = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().width && element.scrollWidth > element.clientWidth + 1)
          .map(element => ({ tag: element.tagName, id: element.id, className: element.className, client: element.clientWidth, scroll: element.scrollWidth })).slice(0, 12) }));
      assert.deepEqual(await bounds(), { problems: [], overflow: false }, `${engineName} ${width}x${height}: ${JSON.stringify(diagnostic)}`);
      if ([320, 390, 1366].includes(width)) await page.screenshot({ path: fileURLToPath(new URL(`network-${engineName}-${width}.png`, screenshots)), fullPage: true });
    }
    assert.deepEqual(errors, []);
  });
}

test("browser owner setup keeps credentials local and requires explicit control after release", { timeout: 20000 }, async context => {
  const url = await startPreview(context, { PREVIEW_CLAIMED: "0" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const ownerPassword = "\u{1f600}".repeat(4);
  let claims = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/claim") claims++; });
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Claim keyboard" })).toBeVisible();
  await page.getByLabel("Owner setup code").fill("0123456789abcdef01234567");
  for (const invalidPassword of ["short", "\u00e9".repeat(65)]) {
    await page.getByLabel("Owner password", { exact: true }).fill(invalidPassword);
    await page.getByLabel("Confirm owner password").fill(invalidPassword);
    await page.getByRole("button", { name: "Claim keyboard", exact: true }).click();
    await expect(page.locator("#ui-message")).toContainText("12 to 128 bytes");
    assert.equal(claims, 0);
  }
  await page.getByLabel("Owner password", { exact: true }).fill(ownerPassword);
  await page.getByLabel("Confirm owner password").fill(ownerPassword);
  await page.getByRole("button", { name: "Claim keyboard", exact: true }).click();
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(page.locator("#take-control")).toBeVisible();
  assert.equal(claims, 1);
  await expect(key).toBeDisabled();
  assert.equal((await counters()).down, 0);
  assert.equal(await page.evaluate(() => document.cookie.includes("kb_session")), false);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await takeControl(page);
  await key.click();
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, pressed: false });
  await page.getByRole("button", { name: "Release all keys" }).click();
  await expect(key).toBeDisabled();
  await expect.poll(counters).toMatchObject({ connected: false, pressed: false });
  await page.reload();
  await expect(page.locator("#take-control")).toBeVisible();
  await expect(key).toBeDisabled();
  for (const ending of ["logout", "poll", "session-refresh", "expired-logout"]) {
    await page.getByRole("button", { name: "Network settings", exact: true }).click();
    await page.getByLabel("Join Wi-Fi", { exact: true }).check();
    await page.getByLabel("Wi-Fi password", { exact: true }).fill("discard-this-candidate");
    if (ending === "logout") await page.getByRole("button", { name: "Sign out", exact: true }).click();
    else if (ending === "expired-logout") {
      await page.getByRole("button", { name: "Back to keyboard", exact: true }).click();
      await page.context().clearCookies();
      const signedOut = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/api/v1/session");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      assert.equal((await signedOut).status(), 401);
    }
    else {
      await page.context().clearCookies();
      if (ending === "session-refresh") await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    }
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.locator("#wifi-password")).toHaveValue("");
    await page.getByLabel("Owner password", { exact: true }).fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await takeControl(page);
});

test("owner session requires authentication, exact origin and CSRF before control", { timeout: 10000 }, async context => {
  const url = await startPreview(context);
  assert.equal((await fetch(new URL("/api/v1/status", url))).status, 401);
  const session = await loginRequest(url);
  const endpoint = new URL("/api/v1/control/take", url);
  const available = async () => {
    const headers = { Cookie: session.cookie };
    const status = await (await fetch(new URL("/api/v1/status", url), { headers })).json();
    const job = await (await fetch(new URL("/api/v1/network/job", url), { headers })).json();
    assert.equal(status.network.can_control, job.can_control);
    return job.can_control;
  };
  assert.equal(await available(), true);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: "http://untrusted.invalid", Cookie: session.cookie, "X-CSRF-Token": session.csrf } })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: url, Cookie: session.cookie } })).status, 403);
  await takeRequest(url, session);
  assert.equal(await available(), false);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf } })).status, 409);
  const recoverySession = await loginRequest(url);
  const recoveryHeaders = { Origin: url, Cookie: recoverySession.cookie, "X-CSRF-Token": recoverySession.csrf };
  assert.equal((await fetch(endpoint, { method: "POST", headers: recoveryHeaders })).status, 409);
  assert.equal((await fetch(new URL("/api/v1/control/stop", url), { method: "POST", headers: recoveryHeaders })).status, 200);
  assert.equal(await available(), true);
  await takeRequest(url, session);
  const logout = await fetch(new URL("/api/v1/session", url), { method: "DELETE", headers: { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(new URL("/api/v1/status", url), { headers: { Cookie: session.cookie } })).status, 401);
});

test("one-time claim changes owner credentials and cannot be reused", { timeout: 10000 }, async context => {
  const url = await startPreview(context, { PREVIEW_CLAIMED: "0" });
  const initial = await (await fetch(new URL("/api/v1/session", url))).json();
  assert.equal(initial.claimed, false);
  const claim = async setupCode => fetch(new URL("/api/v1/claim", url), {
    method: "POST", headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ setup_code: setupCode, password: "literal\\u0000" }),
  });
  const duplicate = await fetch(new URL("/api/v1/claim", url), {
    method: "POST", headers: { Origin: url, "Content-Type": "application/json" },
    body: '{"setup_code":"0123456789abcdef01234567","password":"first-password","password":"last-password"}',
  });
  assert.equal(duplicate.status, 400);
  assert.equal((await claim("000000000000000000000000")).status, 401);
  const delayedBody = JSON.stringify({ setup_code: "0123456789abcdef01234567", password: "competing-owner-password" });
  const delayedClaim = httpRequest(new URL("/api/v1/claim", url), {
    method: "POST", headers: { Origin: url, "Content-Type": "application/json", Expect: "100-continue", "Content-Length": Buffer.byteLength(delayedBody) },
  });
  context.after(() => delayedClaim.destroy());
  const ready = once(delayedClaim, "continue");
  const delayedResponse = once(delayedClaim, "response");
  delayedClaim.flushHeaders();
  await ready;
  const successful = await claim("0123456789abcdef01234567");
  assert.equal(successful.status, 200);
  assert.equal((await successful.json()).authenticated, true);
  delayedClaim.end(delayedBody);
  const [rejected] = await delayedResponse;
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.headers["set-cookie"], undefined);
  rejected.resume();
  assert.equal((await claim("0123456789abcdef01234567")).status, 409);
  await loginRequest(url, "literal\\u0000");
});

test("WebSocket authorization requires a session and explicit control reservation", { timeout: 10000 }, async context => {
  const url = await startPreview(context);
  const session = await loginRequest(url);
  const endpoint = new URL("/api/v1/keyboard", url);
  endpoint.protocol = "ws:";
  for (const headers of [{ Origin: url }, { Origin: url, Cookie: session.cookie },
    { Origin: "http://untrusted.invalid", Cookie: session.cookie }, { Origin: url, Host: "untrusted.invalid", Cookie: session.cookie }]) {
    const denied = new WebSocket(endpoint, { headers });
    const error = await once(denied, "error");
    assert.match(error[0].message, /403/);
  }
  await takeRequest(url, session);
  const connection = new WebSocket(endpoint, { headers: { Origin: url, Cookie: session.cookie } });
  context.after(() => connection.terminate());
  await once(connection, "open");
  const activeStatus = await (await fetch(new URL("/api/v1/status", url), { headers: { Cookie: session.cookie } })).json();
  assert.equal(activeStatus.network.can_control, false);
  const recoverySession = await loginRequest(url);
  const recoveryHeaders = { Origin: url, Cookie: recoverySession.cookie, "X-CSRF-Token": recoverySession.csrf };
  assert.equal((await fetch(new URL("/api/v1/control/take", url), { method: "POST", headers: recoveryHeaders })).status, 409);
  const response = await fetch(new URL("/api/v1/control/stop", url), {
    method: "POST", headers: recoveryHeaders,
  });
  assert.equal(response.status, 200);
  await expect.poll(async () => (await (await fetch(new URL("/__test__/input", url))).json()).connected).toBe(false);
});

test("mock backend records received states, acknowledgements, and stop", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const session = await loginRequest(url);
  await takeRequest(url, session);
  const endpoint = new URL("/api/v1/keyboard", url);
  endpoint.protocol = "ws:";
  const connection = new WebSocket(endpoint, { headers: { Origin: url, Cookie: session.cookie } });
  context.after(() => connection.terminate());
  await once(connection, "open");

  async function exchange(message) {
    const reply = once(connection, "message");
    connection.send(JSON.stringify(message));
    return JSON.parse(String((await reply)[0]));
  }

  assert.equal((await exchange({ v: 1, type: "ping" })).usb_ready, true);
  assert.equal((await exchange({ v: 1, type: "state", seq: 1, modifiers: 0, keys: [4] })).type, "queued");
  assert.equal((await exchange({ v: 1, type: "state", seq: 2, modifiers: 0, keys: [] })).type, "queued");
  let response = await fetch(new URL("/__test__/input", url));
  assert.deepEqual(await response.json(), {
    down: 1, up: 1, stop: 0, queued: 2, forced_release: 0,
    connected: true, pressed: false,
    report: { modifiers: 0, keys: [] }, caps_lock: false,
  });

  assert.equal((await exchange({ v: 1, type: "state", seq: 3, modifiers: 0, keys: [4] })).type, "queued");
  const closed = once(connection, "close");
  connection.send(JSON.stringify({ v: 1, type: "stop" }));
  await closed;
  response = await fetch(new URL("/__test__/input", url));
  const receipts = await response.json();
  assert.equal(receipts.down, 2);
  assert.equal(receipts.up, 1);
  assert.equal(receipts.stop, 1);
  assert.equal(receipts.queued, 3);
  assert.equal(receipts.pressed, false);
});

test("real browser keyboard, mouse, and touch reach the backend once per tap", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 1366, height: 768 } });
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== url) externalRequests.push(request.url());
  });
  await page.goto(url);
  await signIn(page);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();
  assert.deepEqual(await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() })),
                   { hidden: false, focused: true });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();

  await key.focus();
  await page.keyboard.down("a");
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 1, up: 0, queued: 1, pressed: true });
  await page.keyboard.up("a");
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, queued: 2, pressed: false });

  await key.click();
  await expect.poll(counters).toMatchObject({ down: 2, up: 2, queued: 4, pressed: false });

  const box = await key.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(counters).toMatchObject({ down: 3, up: 3, queued: 6, pressed: false });
  assert.equal(await key.evaluate(element => getComputedStyle(element).webkitTapHighlightColor), "rgba(0, 0, 0, 0)");

  const screenshots = new URL("../.cache/tests/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("keyboard-desktop.png", screenshots)) });
  for (const viewport of [{ width: 375, height: 667 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const key = document.querySelector("#a-key").getBoundingClientRect();
      const header = document.querySelector("header").getBoundingClientRect();
      const footer = document.querySelector("footer").getBoundingClientRect();
      return { width: key.width, height: key.height,
        overflow: document.documentElement.scrollWidth > innerWidth,
        overlap: key.top < header.bottom || key.bottom > footer.top };
    });
    assert.ok(layout.width >= 27 && layout.height >= 44);
    assert.equal(layout.overflow, false);
    assert.equal(layout.overlap, false);
    await page.screenshot({ path: fileURLToPath(new URL(`keyboard-${viewport.width}.png`, screenshots)) });
  }
  assert.deepEqual(externalRequests, []);
  console.log("Browser receipt totals:", JSON.stringify(await counters()));
});

test("mixed holds, touch cancellation, editable focus, and navigation release input", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 375, height: 667 } });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  await signIn(page);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();

  await key.focus();
  await page.keyboard.down("a");
  const box = await key.boundingBox();
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.keyboard.up("a");
  await expect(key).toHaveAttribute("aria-pressed", "true");
  await expect.poll(counters).toMatchObject({ down: 1, up: 0, pressed: true });
  await page.mouse.up();
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, pressed: false });

  const touchSession = await page.context().newCDPSession(page);
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: center.x - 6, y: center.y, id: 1 }, { x: center.x + 6, y: center.y, id: 2 }],
  });
  await expect.poll(counters).toMatchObject({ down: 2, up: 1, pressed: true });
  await touchSession.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await expect.poll(counters).toMatchObject({ down: 2, up: 1, stop: 1, pressed: false });

  await expect(key).toBeDisabled();
  await takeControl(page);
  await key.focus();
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 3, pressed: true });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "local-field";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.up("a");
  await expect.poll(counters).toMatchObject({ down: 3, stop: 2, pressed: false });
  await expect(key).toBeDisabled();
  await page.locator("#local-field").press("a");
  await page.locator("#local-field").press("Control+a");
  assert.equal((await counters()).down, 3);

  await takeControl(page);
  await key.focus();
  await page.keyboard.down("a");
  await expect.poll(counters).toMatchObject({ down: 4, pressed: true });
  await page.goto("about:blank");
  await expect.poll(counters).toMatchObject({ down: 4, up: 1, pressed: false });
  const final = await counters();
  assert.ok(final.stop + final.forced_release >= 3);
});

test("a lost WebSocket clears a held key without an explicit up", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const session = await loginRequest(url);
  await takeRequest(url, session);
  const endpoint = new URL("/api/v1/keyboard", url);
  endpoint.protocol = "ws:";
  const connection = new WebSocket(endpoint, { headers: { Origin: url, Cookie: session.cookie } });
  context.after(() => connection.terminate());
  await once(connection, "open");
  const queued = once(connection, "message");
  connection.send(JSON.stringify({ v: 1, type: "state", seq: 1, modifiers: 0, keys: [4] }));
  assert.equal(JSON.parse(String((await queued)[0])).type, "queued");
  const closed = once(connection, "close");
  connection.terminate();
  await closed;
  await expect.poll(async () => (await fetch(new URL("/__test__/input", url))).json())
    .toMatchObject({ down: 1, up: 0, stop: 0, forced_release: 1, pressed: false });
});

test("iPhone Shift, Caps feedback, symbols and typing controls send the expected reports", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  const report = async () => (await counters()).report;
  const neutral = { modifiers: 0, keys: [] };
  await page.goto(url);
  await signIn(page);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();

  async function hold(label, expected) {
    const button = page.getByRole("button", { name: label, exact: true });
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(report).toEqual(expected);
    await page.mouse.up();
    await expect.poll(report).toEqual(neutral);
  }

  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await shift.click();
  await expect(shift).toHaveAttribute("data-shift", "latched");
  await hold("Q", { modifiers: 2, keys: [20] });
  await expect(shift).toHaveAttribute("data-shift", "off");
  await shift.dblclick({ delay: 60 });
  await expect(page.locator("#caps-status")).toHaveText("Caps on");
  await expect(page.getByRole("button", { name: "A", exact: true })).toHaveText("A");
  await hold("A", { modifiers: 0, keys: [4] });
  await shift.click();
  await expect(page.locator("#caps-status")).toHaveText("Caps off");

  await page.getByRole("button", { name: "123", exact: true }).click();
  await hold("@", { modifiers: 2, keys: [31] });
  await hold("9", { modifiers: 0, keys: [38] });
  await page.getByRole("button", { name: "#+=", exact: true }).click();
  await hold("~", { modifiers: 2, keys: [53] });
  await hold("\\", { modifiers: 0, keys: [49] });
  await hold("=", { modifiers: 0, keys: [46] });
  for (const [label, usage] of [["Backspace", 42], ["Space", 44], ["Return", 40]]) {
    await hold(label, { modifiers: 0, keys: [usage] });
  }
  await page.keyboard.down("x");
  await expect.poll(report).toEqual({ modifiers: 0, keys: [27] });
  await page.getByRole("button", { name: "ABC", exact: true }).click();
  await expect.poll(report).toEqual(neutral);
  await page.keyboard.up("x");

  const shiftBox = await shift.boundingBox();
  const letterBox = await page.getByRole("button", { name: "A", exact: true }).boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { x: shiftBox.x + shiftBox.width / 2, y: shiftBox.y + shiftBox.height / 2, id: 1 },
    { x: letterBox.x + letterBox.width / 2, y: letterBox.y + letterBox.height / 2, id: 2 },
  ] });
  await expect.poll(report).toEqual({ modifiers: 2, keys: [4] });
  await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(report).toEqual(neutral);
  await expect(shift).toHaveAttribute("data-shift", "off");
  await page.keyboard.down("ShiftRight");
  await page.keyboard.down("z");
  await expect.poll(report).toEqual({ modifiers: 32, keys: [29] });
  await page.keyboard.up("z");
  await page.keyboard.up("ShiftRight");
  await expect.poll(report).toEqual(neutral);
});

test("six-key overflow releases without sending a partial seventh-key chord", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const states = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === "state") states.push(message);
  }));
  await page.goto(url);
  await signIn(page);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  for (const letter of "abcdef") await page.keyboard.down(letter);
  await expect.poll(async () => (await (await fetch(new URL("/__test__/input", url))).json()).report.keys.length).toBe(6);
  await page.keyboard.down("g");
  await expect.poll(async () => (await fetch(new URL("/__test__/input", url))).json())
    .toMatchObject({ pressed: false, stop: 1, down: 6 });
  assert.ok(states.every(state => state.keys.length <= 6 && !state.keys.includes(10)));
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeDisabled();
  await takeControl(page);
  await page.keyboard.down("a");
  for (const letter of "abcdefg") await page.keyboard.up(letter);
  const final = await (await fetch(new URL("/__test__/input", url))).json();
  assert.equal(final.down, 6);
  assert.equal(final.pressed, false);
});

test("unknown Caps feedback is not replaced by a guessed lock state", { timeout: 10000 }, async (context) => {
  const url = await startPreview(context, { PREVIEW_CAPS_LOCK: "unknown" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await signIn(page);
  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await expect(shift).toBeEnabled();
  await shift.dblclick({ delay: 60 });
  await expect(page.locator("#caps-status")).toHaveText("Caps pending");
  await expect(page.locator("#caps-status")).toHaveText("Caps unknown");
  assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).caps_lock, null);
});

test("all keyboard pages fit phone, tablet and desktop viewports without overlapping keys", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true });
  const errors = [];
  const external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).origin !== url) external.push(request.url()); });
  await page.goto(url);
  await signIn(page);
  await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  const screenshots = new URL("../.cache/tests/", import.meta.url);
  await mkdir(screenshots, { recursive: true });
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320],
    [844, 390], [768, 1024], [1024, 768], [1366, 768], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ["letters", "numbers", "symbols"]) {
      if (mode === "letters" && await page.locator("#key-rows").getAttribute("data-page") !== "letters") {
        await page.getByRole("button", { name: "ABC", exact: true }).click();
      } else if (mode === "numbers") {
        await page.getByRole("button", { name: "123", exact: true }).click();
      } else if (mode === "symbols") {
        await page.getByRole("button", { name: "#+=", exact: true }).click();
      }
      const layout = await page.evaluate(() => {
        const keys = [...document.querySelectorAll("#key-rows button")];
        const header = document.querySelector("header").getBoundingClientRect();
        const footer = document.querySelector("footer").getBoundingClientRect();
        const problems = [];
        const bounds = keys.map(button => button.getBoundingClientRect());
        keys.forEach((button, index) => {
          const box = bounds[index];
          if (box.width < 27 || box.height < 44) problems.push(`target:${button.getAttribute("aria-label")}`);
          if (box.left < 0 || box.right > innerWidth || box.top < header.bottom || box.bottom > footer.top) problems.push("bounds");
          if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) problems.push("label overflow");
          for (let other = index + 1; other < bounds.length; other++) {
            const next = bounds[other];
            if (box.left < next.right && box.right > next.left && box.top < next.bottom && box.bottom > next.top) problems.push("overlap");
          }
        });
        return { problems, width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight, viewportHeight: innerHeight };
      });
      assert.deepEqual(layout.problems, [], `${width}x${height} ${mode}`);
      assert.ok(layout.width <= width, `Horizontal scrolling at ${width}x${height} ${mode}`);
      assert.ok(layout.height <= layout.viewportHeight + 1, `Vertical scrolling at ${width}x${height} ${mode}: ${layout.height}`);
      if ([320, 390, 568, 768, 1366].includes(width)) {
        await page.screenshot({ path: fileURLToPath(new URL(`keyboard-${width}-${mode}.png`, screenshots)) });
      }
    }
  }
  for (const icon of ["shift", "caps", "backspace", "return", "release"]) {
    const response = await fetch(new URL(`/icons/${icon}.svg`, url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await response.text(), /<svg/);
  }
  for (const [width, height, top, right, bottom, left] of [[390, 844, 59, 0, 34, 0], [844, 390, 0, 59, 21, 59]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(insets => {
      for (const [side, value] of Object.entries(insets)) document.documentElement.style.setProperty(`--safe-${side}`, `${value}px`);
    }, { top, right, bottom, left });
    const safeLayout = await page.evaluate(() => {
      const header = document.querySelector("header").getBoundingClientRect();
      const footer = document.querySelector("footer").getBoundingClientRect();
      const keys = document.querySelector("#key-rows").getBoundingClientRect();
      return { top: header.top, bottom: footer.bottom, left: keys.left, right: keys.right,
        keyBottom: keys.bottom, footerTop: footer.top, height: document.documentElement.scrollHeight };
    });
    assert.ok(safeLayout.top >= top && safeLayout.bottom <= height - bottom);
    assert.ok(safeLayout.left >= left && safeLayout.right <= width - right);
    assert.ok(safeLayout.keyBottom <= safeLayout.footerTop && safeLayout.height <= height + 1);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

test("buffered sockets, dropped acknowledgements and send errors release and recover without replay", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.transportFault = null;
    const send = WebSocket.prototype.send;
    const listen = WebSocket.prototype.addEventListener;
    const buffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount");
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      get() { return window.transportFault === "buffered" ? 2048 : buffered.get.call(this); },
    });
    WebSocket.prototype.send = function (data) {
      if (window.transportFault === "send") throw new Error("Simulated socket send failure");
      return send.call(this, data);
    };
    WebSocket.prototype.addEventListener = function (type, callback, options) {
      if (type !== "message") return listen.call(this, type, callback, options);
      return listen.call(this, type, event => {
        if (window.transportFault === "ack" && JSON.parse(event.data).type === "queued") return;
        callback.call(this, event);
      }, options);
    };
  });
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  await signIn(page);
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(key).toBeEnabled();
  for (const fault of ["buffered", "ack", "send"]) {
    const baseline = await counters();
    await page.locator("#keyboard").focus();
    await page.evaluate(fault => { window.transportFault = fault; }, fault);
    await page.keyboard.down("a");
    await expect(key).toBeDisabled();
    await expect.poll(async () => (await counters()).pressed).toBe(false);
    await page.evaluate(() => { window.transportFault = null; });
    await takeControl(page);
    await page.keyboard.down("a");
    await page.keyboard.up("a");
    const received = await counters();
    assert.equal(received.down - baseline.down, fault === "ack" ? 1 : 0, fault);
    assert.equal(received.pressed, false);
  }
  assert.deepEqual(pageErrors, []);
});

test("WebKit loads and types across the iPhone pages with touch and physical keys", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE_PATH });
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  await page.goto(url);
  await page.bringToFront();
  await signIn(page);
  const letter = page.getByRole("button", { name: "A", exact: true });
  await expect(letter).toBeEnabled();
  await letter.tap();
  await expect.poll(counters).toMatchObject({ down: 1, up: 1, queued: 2, pressed: false });
  const shift = page.getByRole("button", { name: "Shift", exact: true });
  await shift.tap();
  await expect(shift).toHaveAttribute("data-shift", "latched");
  await page.keyboard.down("b");
  await expect.poll(counters).toMatchObject({ report: { modifiers: 2, keys: [5] } });
  await page.keyboard.up("b");
  await expect.poll(counters).toMatchObject({ pressed: false });
  await page.getByRole("button", { name: "123", exact: true }).tap();
  await page.getByRole("button", { name: "@", exact: true }).tap();
  await page.getByRole("button", { name: "#+=", exact: true }).tap();
  await page.getByRole("button", { name: "~", exact: true }).tap();
  await expect.poll(counters).toMatchObject({ down: 4, up: 4, pressed: false });
  assert.ok(await page.locator('[data-code="Backspace"] .icon').evaluate(element => getComputedStyle(element).maskImage !== "none"));
  await page.screenshot({ path: fileURLToPath(new URL("../.cache/tests/keyboard-webkit-phone.png", import.meta.url)) });
  await page.setViewportSize({ width: 844, height: 390 });
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assert.ok(layout.width <= 844 && layout.height <= 390);
  await page.getByRole("button", { name: "Return", exact: true }).tap();
  await expect.poll(counters).toMatchObject({ down: 5, up: 5, pressed: false });
  assert.deepEqual(errors, []);
});