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

function previewUpdateImage(version = "0.1.1") {
  const image = Buffer.alloc(8192, 0xff);
  image[0] = 0xe9;
  image.fill(0, 0x120, 0x220);
  image.write("KBOTA001", 0x120);
  image.write("esp32s3-generic-16m", 0x120 + 72);
  image.write("kb16-ab6-nvs64-v1", 0x120 + 104);
  image.write(version, 0x120 + 184);
  image[4096] = 0xe7;
  return image;
}

for (const mode of ["ap", "station"]) test(`OTA API stages, cancels and activates in ${mode} mode without resetting settings`, { timeout: 12000 }, async context => {
  const url = await startPreview(context, { PREVIEW_NETWORK_MODE: mode, PREVIEW_UPDATE_DELAY_MS: "100" });
  const session = await loginRequest(url);
  const headers = { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
  const call = (path, method = "GET", body) => fetch(new URL(path, url), { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const upload = (body = previewUpdateImage(), extraHeaders = {}) => fetch(new URL("/api/v1/update", url), {
    method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream", ...extraHeaders }, body });
  assert.equal((await fetch(new URL("/api/v1/firmware", url))).status, 401);
  assert.equal((await upload(previewUpdateImage(), { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await upload(Buffer.alloc(8193))).status, 400);
  assert.equal((await upload(previewUpdateImage("0.1.0"))).status, 400);
  await takeRequest(url, session);
  assert.equal((await upload()).status, 409);
  assert.equal((await call("/api/v1/control/stop", "POST")).status, 200);
  const before = await (await call("/api/v1/network/job")).json();
  assert.equal(before.ap_active, mode === "ap");
  const staged = await (await upload()).json();
  assert.equal(staged.phase, "staged");
  assert.match(staged.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await call("/api/v1/control/take", "POST")).status, 409);
  assert.equal((await call("/api/v1/network", "POST", { action: "ap" })).status, 409);
  assert.equal((await upload()).status, 409);
  const other = await loginRequest(url);
  assert.equal((await fetch(new URL("/api/v1/update/job", url), { headers: { Cookie: other.cookie } })).status, 403);
  assert.equal((await call("/api/v1/update/activate", "POST", { job_id: staged.job_id + 1, sha256: staged.sha256 })).status, 409);
  assert.equal((await call("/api/v1/update/job", "DELETE", { job_id: staged.job_id })).status, 202);
  assert.equal((await fetch(new URL("/api/v1/update/job", url), { headers: { Cookie: other.cookie } })).status, 200);
  assert.equal((await call("/api/v1/update/activate", "POST", { job_id: staged.job_id, sha256: staged.sha256 })).status, 409);
  const next = await (await upload()).json();
  assert.equal((await call("/api/v1/update/activate", "POST", { job_id: next.job_id, sha256: next.sha256 })).status, 202);
  await expect.poll(async () => (await call("/api/v1/firmware")).status).toBe(401);
  const renewed = await loginRequest(url);
  const firmware = await (await fetch(new URL("/api/v1/firmware", url), { headers: { Cookie: renewed.cookie } })).json();
  assert.equal(firmware.version, "0.1.1");
  const after = await (await fetch(new URL("/api/v1/network/job", url), { headers: { Cookie: renewed.cookie } })).json();
  assert.equal(after.ap_active, before.ap_active);
  assert.equal(after.saved_ssid, before.saved_ssid);
  assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).down, 0);
});

for (const ending of ["failed", "cancelled", "expired", "logout"]) test(`OTA API releases terminal ownership after ${ending}`, { timeout: 10000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_DELAY_MS: "10", PREVIEW_UPDATE_STAGED_MS: "500" });
  const owner = await loginRequest(url);
  const other = await loginRequest(url);
  const call = (session, path, method = "GET", body) => fetch(new URL(path, url), {
    method, headers: { Cookie: session.cookie, Origin: url, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const upload = (session, version = "0.1.1") => fetch(new URL("/api/v1/update", url), {
    method: "POST", headers: { Cookie: session.cookie, Origin: url, "X-CSRF-Token": session.csrf,
      "Content-Type": "application/octet-stream" }, body: previewUpdateImage(version) });
  const response = await upload(owner, ending === "failed" ? "0.1.0" : "0.1.1");
  assert.equal(response.status, ending === "failed" ? 400 : 200);
  const first = await response.json();
  if (ending !== "failed") assert.equal((await call(other, "/api/v1/update/job")).status, 403);
  if (ending === "cancelled") assert.equal((await call(owner, "/api/v1/update/job", "DELETE", { job_id: first.job_id })).status, 202);
  if (ending === "logout") assert.equal((await call(owner, "/api/v1/session", "DELETE")).status, 200);
  await expect.poll(async () => (await call(other, "/api/v1/update/job")).status).toBe(200);
  const next = await upload(other);
  assert.equal(next.status, 200);
  const job = await next.json();
  assert.equal(job.phase, "staged");
  assert.equal((await call(other, "/api/v1/update/job", "DELETE", { job_id: job.job_id })).status, 202);
});

for (const ending of ["timeout", "cancel", "logout"]) test(`OTA stalled body is closed and released after ${ending}`, { timeout: 12000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_IDLE_MS: "1000", PREVIEW_UPDATE_DELAY_MS: "10" });
  const owner = await loginRequest(url);
  const other = await loginRequest(url);
  const headers = session => ({ Cookie: session.cookie, Origin: url, "X-CSRF-Token": session.csrf });
  const stalled = httpRequest(new URL("/api/v1/update", url), { method: "POST", headers: {
    ...headers(owner), "Content-Type": "application/octet-stream", "Content-Length": "8192" } });
  const closed = new Promise(resolve => stalled.once("close", resolve));
  stalled.on("error", () => {});
  stalled.on("response", response => response.resume());
  context.after(() => stalled.destroy());
  stalled.write(previewUpdateImage().subarray(0, 1024));
  const job = async () => (await fetch(new URL("/api/v1/update/job", url), { headers: headers(owner) })).json();
  await expect.poll(async () => (await job()).received).toBe(1024);
  const current = await job();
  if (ending !== "timeout") {
    const response = await fetch(new URL(ending === "logout" ? "/api/v1/session" : "/api/v1/update/job", url), {
      method: "DELETE", headers: { ...headers(owner), "Content-Type": "application/json" },
      ...(ending === "cancel" ? { body: JSON.stringify({ job_id: current.job_id }) } : {}) });
    assert.equal(response.status, ending === "logout" ? 200 : 202);
  }
  await closed;
  const terminal = await fetch(new URL("/api/v1/update/job", url), { headers: headers(other) });
  assert.equal(terminal.status, 200);
  const result = await terminal.json();
  assert.equal(result.busy, false);
  assert.equal(result.error, ending === "timeout" ? "update_timeout" : "cancelled");
  const next = await fetch(new URL("/api/v1/update", url), { method: "POST", headers: {
    ...headers(other), "Content-Type": "application/octet-stream" }, body: previewUpdateImage() });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).phase, "staged");
});

test("OTA cancelled verification cannot release a newer upload", { timeout: 12000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_DELAY_MS: "1500" });
  const owner = await loginRequest(url);
  const other = await loginRequest(url);
  const headers = session => ({ Cookie: session.cookie, Origin: url, "X-CSRF-Token": session.csrf });
  const upload = session => fetch(new URL("/api/v1/update", url), { method: "POST", headers: {
    ...headers(session), "Content-Type": "application/octet-stream" }, body: previewUpdateImage() });
  const first = upload(owner).catch(() => null);
  const job = async session => (await fetch(new URL("/api/v1/update/job", url), { headers: headers(session) })).json();
  await expect.poll(async () => (await job(owner)).phase).toBe("verifying");
  const current = await job(owner);
  assert.equal((await fetch(new URL("/api/v1/update/job", url), { method: "DELETE", headers: {
    ...headers(owner), "Content-Type": "application/json" }, body: JSON.stringify({ job_id: current.job_id }) })).status, 202);
  const second = upload(other);
  await expect.poll(async () => (await job(other)).phase).toBe("verifying");
  await first;
  assert.equal((await job(other)).busy, true);
  assert.equal((await upload(owner)).status, 409);
  const response = await second;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job_id, current.job_id + 1);
});

for (const engine of [chromium, webkit]) test(`Keyboard and OTA pages stay separate in ${engine.name()}`, { timeout: 15000 }, async context => {
  const url = await startPreview(context);
  const browser = await engine.launch(engine === webkit && process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const requests = [];
  const errors = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator("#account-submit")).toBeEnabled();
  await page.locator("#owner-password").fill("preview-owner-password");
  await page.locator("#account-submit").click();
  await expect(page.locator("#keyboard")).toBeVisible();
  await page.locator("#network-settings").click();
  await expect(page.locator("#network-view")).toBeVisible();
  await expect(page.locator('#firmware-settings, #firmware-view, a[href="/ota"]')).toHaveCount(0);
  assert.equal(requests.some(path => path === "/ota.mjs" || /^\/api\/v1\/(firmware|update)/.test(path)), false);
  requests.length = 0;
  await page.goto(new URL("/ota", url).href);
  await expect(page.locator("#firmware-version")).toHaveText("0.1.0");
  await expect(page.locator('#keyboard, #network-view, #network-settings, #firmware-back, a[href="/"]')).toHaveCount(0);
  assert.equal(requests.includes("/app.mjs") || requests.includes("/keyboard.mjs"), false);
  assert.deepEqual(errors, []);
});

for (const engine of [chromium, webkit]) for (const rollback of [false, true]) test(`Firmware view uploads, cancels and confirms ${rollback ? "rollback" : "reboot"} in ${engine.name()}`, { timeout: 30000 }, async context => {
  const url = await startPreview(context, { PREVIEW_NETWORK_MODE: engine === chromium ? "station" : "ap", PREVIEW_UPDATE_DELAY_MS: "150",
    PREVIEW_UPDATE_FAIL: rollback ? "boot" : "" });
  const browser = await engine.launch(engine === webkit && process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const updateRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (/\/api\/v1\/(firmware|update)/.test(request.url())) {
      updateRequests.push({ event: "request", method: request.method(), path: new URL(request.url()).pathname });
    }
  });
  page.on("response", response => {
    if (/\/api\/v1\/(firmware|update)/.test(response.url())) {
      updateRequests.push({ event: "response", status: response.status(), path: new URL(response.url()).pathname });
    }
  });
  let uploadCount = 0;
  if (engine === chromium) {
    await page.route("**/api/v1/update", async route => {
      if (++uploadCount === 2) {
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
  }
  await page.goto(new URL("/ota", url).href);
  const signIn = async () => {
    await expect(page.locator("#account-submit")).toBeEnabled();
    await page.locator("#owner-password").fill("preview-owner-password");
    await page.locator("#account-submit").click();
    await expect(page.locator("#account-view")).toBeHidden();
  };
  await signIn();
  await expect(page.locator("#network-settings, #firmware-back, #keyboard, #take-control")).toHaveCount(0);
  await expect(page.locator("#firmware-version")).toHaveText("0.1.0");
  const upload = async () => {
    await page.locator("#firmware-file").setInputFiles({ name: "keyboard-0.1.1.bin", mimeType: "application/octet-stream", buffer: previewUpdateImage() });
    await expect(page.locator("#firmware-upload")).toBeEnabled();
    await page.locator("#firmware-upload").click();
    try {
      await expect(page.locator("#firmware-activate")).toBeVisible();
    } catch (error) {
      console.error("OTA upload state:", JSON.stringify({
        status: await page.locator("#firmware-status").textContent(),
        message: await page.locator("#ui-message").textContent(),
        job: await (await page.request.get(new URL("/api/v1/update/job", url).href)).json(),
        visibility: await page.evaluate(() => document.visibilityState),
        requests: updateRequests,
        pageErrors: errors,
      }));
      throw error;
    }
    await expect(page.locator("#firmware-candidate")).toHaveText("0.1.1");
  };
  await upload();
  await page.keyboard.press("x");
  await page.locator("#firmware-cancel").click();
  await expect(page.locator("#firmware-status")).toHaveText("Update cancelled");
  await upload();
  if (engine === chromium) assert.equal(uploadCount, 2, "A lost upload response must not replay the upload");
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    await expect(page.locator("#ui-message")).toBeHidden();
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
      boxes: ["firmware-version", "firmware-status", "firmware-form", "firmware-activate"].map(id => {
        const box = document.getElementById(id).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      }) }));
    assert.equal(layout.width, layout.viewport);
    assert.ok(layout.boxes.every(box => box.left >= 0 && box.right <= viewport.width));
    assert.ok(layout.boxes[1].bottom <= layout.boxes[2].top && layout.boxes[2].bottom <= layout.boxes[3].top);
    await mkdir(new URL("../.cache/tests/", import.meta.url), { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`../.cache/tests/ota-${engine.name()}-${viewport.width}.png`, import.meta.url)), fullPage: true });
  }
  await page.locator("#firmware-activate").click();
  await expect(page.locator("#account-view")).toBeVisible();
  await signIn();
  await expect(page.locator("#firmware-version")).toHaveText(rollback ? "0.1.0" : "0.1.1");
  await expect(page.locator("#firmware-status")).toHaveText(rollback ? "Update not confirmed; version 0.1.0 is running" : "Version 0.1.1 is running");
  await expect(page).toHaveURL(new URL("/ota", url).href);
  const input = await (await fetch(new URL("/__test__/input", url))).json();
  assert.equal(input.down, 0);
  assert.equal(input.connected, false);
  assert.deepEqual(errors, []);
});

for (const engine of [chromium, webkit]) test(`Firmware activation recovers a lost request without reupload in ${engine.name()}`, { timeout: 20000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_DELAY_MS: "100" });
  const browser = await engine.launch(engine === webkit && process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
  context.after(() => browser.close());
  const page = await browser.newPage();
  let activations = 0;
  let uploads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/update") uploads++; });
  await page.route("**/api/v1/update/activate", async route => {
    if (++activations === 2) assert.equal((await route.fetch()).status(), 202);
    await route.abort();
  });
  await page.goto(new URL("/ota", url).href);
  const signIn = async () => {
    await expect(page.locator("#account-submit")).toBeEnabled();
    await page.locator("#owner-password").fill("preview-owner-password");
    await page.locator("#account-submit").click();
    await expect(page.locator("#account-view")).toBeHidden();
  };
  await signIn();
  await expect(page.locator("#firmware-file")).toBeEnabled();
  await page.locator("#firmware-file").setInputFiles({ name: "test.bin", mimeType: "application/octet-stream", buffer: previewUpdateImage() });
  await page.locator("#firmware-upload").click();
  await expect(page.locator("#firmware-activate")).toBeEnabled();
  const staged = await (await page.request.get(new URL("/api/v1/update/job", url).href)).json();
  await page.locator("#firmware-activate").click();
  await expect(page.locator("#firmware-activate")).toBeVisible();
  await expect(page.locator("#firmware-activate")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("keyboard.pending-firmware.v1"))).toBe(null);
  const unchanged = await (await page.request.get(new URL("/api/v1/update/job", url).href)).json();
  assert.equal(unchanged.phase, "staged");
  assert.equal(unchanged.job_id, staged.job_id);
  assert.equal(unchanged.sha256, staged.sha256);
  assert.equal(activations, 1);
  assert.equal(uploads, 1);
  await page.locator("#firmware-activate").click();
  await expect(page.locator("#account-view")).toBeVisible();
  await signIn();
  await expect(page.locator("#firmware-status")).toHaveText("Version 0.1.1 is running");
  assert.equal(activations, 2);
  assert.equal(uploads, 1);
  await expect(page).toHaveURL(new URL("/ota", url).href);
});

test("Firmware activation ignores a staged poll started before the request", { timeout: 15000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_DELAY_MS: "100" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  let holdPoll = false;
  let releasePoll, pollCaptured, releaseActivation, activationCaptured;
  const pollReady = new Promise(resolve => { pollCaptured = resolve; });
  const activationReady = new Promise(resolve => { activationCaptured = resolve; });
  const allowPoll = new Promise(resolve => { releasePoll = resolve; });
  const allowActivation = new Promise(resolve => { releaseActivation = resolve; });
  context.after(() => { releasePoll(); releaseActivation(); });
  await page.route("**/api/v1/update/job", async route => {
    if (holdPoll && route.request().method() === "GET") {
      holdPoll = false;
      const response = await route.fetch();
      pollCaptured();
      await allowPoll;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.route("**/api/v1/update/activate", async route => {
    activationCaptured();
    await allowActivation;
    await route.abort();
  });
  await page.goto(new URL("/ota", url).href);
  await expect(page.locator("#account-submit")).toBeEnabled();
  await page.locator("#owner-password").fill("preview-owner-password");
  await page.locator("#account-submit").click();
  await expect(page.locator("#firmware-file")).toBeEnabled();
  await page.locator("#firmware-file").setInputFiles({ name: "test.bin", mimeType: "application/octet-stream", buffer: previewUpdateImage() });
  await page.locator("#firmware-upload").click();
  await expect(page.locator("#firmware-activate")).toBeEnabled();
  holdPoll = true;
  await page.locator("#firmware-refresh").click();
  await pollReady;
  await page.locator("#firmware-activate").click();
  await activationReady;
  const stagedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/update/job");
  releasePoll();
  await stagedResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => sessionStorage.getItem("keyboard.pending-firmware.v1")), "0.1.1");
  await expect(page.locator("#firmware-activate")).toBeHidden();
  releaseActivation();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("keyboard.pending-firmware.v1"))).toBe(null);
  await expect(page.locator("#firmware-activate")).toBeEnabled();
});

test("Firmware view cancels during verification before the first job poll", { timeout: 15000 }, async context => {
  const url = await startPreview(context, { PREVIEW_UPDATE_DELAY_MS: "1500" });
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/v1/update")) requests.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
  await page.goto(new URL("/ota", url).href);
  await expect(page.locator("#account-submit")).toBeEnabled();
  await page.locator("#owner-password").fill("preview-owner-password");
  await page.locator("#account-submit").click();
  await expect(page.locator("#firmware-file")).toBeEnabled();
  await page.locator("#firmware-file").setInputFiles({ name: "test.bin", mimeType: "application/octet-stream", buffer: previewUpdateImage() });
  await page.locator("#firmware-upload").click();
  await page.locator("#firmware-cancel").click();
  await expect.poll(() => requests.filter(request => request.method === "DELETE").length,
    { message: "Cancel must reach the device, not only abort the browser upload" }).toBe(1);
  await expect(page.locator("#firmware-status")).toHaveText("Update cancelled");
  await expect(page.locator("#firmware-activate")).toBeHidden();
  await expect(page.locator("#firmware-file")).toBeEnabled();
  await expect(page.locator("#firmware-version")).toHaveText("0.1.0");
});

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
    '{"action":"connect","ssid":"\\ud800","password":"test-password"}',
    '{"action":"connect","ssid":"\\udc00","password":"test-password"}',
    Buffer.concat([Buffer.from('{"action":"connect","ssid":"'), Buffer.from([0xff]), Buffer.from('","password":"test-password"}')]),
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
  const controlledName = (await status()).scan.find(item => item.ssid_hex === Buffer.from("Open\u202e network").toString("hex"));
  assert.equal(controlledName.ssid, "Open\\xE2\\x80\\xAE network");
  assert.equal(controlledName.supported, false);
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
  assert.equal((await fetch(scanEndpoint, { method: "POST", headers })).status, 202);
  assert.equal((await submit({ action: "cancel" })).status, 202);
  await expect.poll(status).toMatchObject({ job: "cancelled", busy: false, phase: "station", ap_active: false,
    station_online: true, desired_station: true, saved_ssid: "Home Wi-Fi", station_ip: "192.168.1.88" });
  assert.equal((await submit({ action: "connect", ssid: "Other network", password: "wrong-password" })).status, 202);
  await expect.poll(status).toMatchObject({ job: "failed", error: "authentication_failed", ap_active: true, saved_ssid: "Home Wi-Fi" });
  assert.equal((await submit({ action: "ap" })).status, 202);
  await expect.poll(status).toMatchObject({ phase: "ap", desired_station: false, has_profile: true, busy: false });
  assert.equal((await submit({ action: "forget" })).status, 202);
  await expect.poll(status).toMatchObject({ saved_ssid: "", has_profile: false, ap_active: true, busy: false });
  assert.equal((await submit({ action: "connect", ssid: "literal\\u0000", password: "literal\\u0000" })).status, 202);
  await expect.poll(status).toMatchObject({ saved_ssid: "literal\\u0000", job: "awaiting_confirmation" });
});

test("storage faults reject writes immediately while status and scans remain usable", { timeout: 10000 }, async context => {
  const url = await startPreview(context, { PREVIEW_STORAGE_FAULT: "1" });
  const session = await loginRequest(url);
  const headers = { Origin: url, Cookie: session.cookie, "X-CSRF-Token": session.csrf, "Content-Type": "application/json" };
  const status = async () => (await fetch(new URL("/api/v1/network/job", url), { headers })).json();
  const before = await status();
  for (const value of [{ action: "ap" }, { action: "forget" }, { action: "rename", hostname: "kb-desk" },
    { action: "station" }, { action: "connect", ssid: "Home Wi-Fi", password: "test-router-password" }]) {
    const response = await fetch(new URL("/api/v1/network", url), { method: "POST", headers, body: JSON.stringify(value) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "storage_failed" });
    assert.deepEqual(await status(), before);
  }
  assert.equal((await fetch(new URL("/api/v1/network/scan", url), { method: "POST", headers })).status, 202);
  await expect.poll(status).toMatchObject({ busy: false, job: "succeeded" });
  await takeRequest(url, session);
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
  const url = await startPreview(context, { PREVIEW_NETWORK_DELAY_MS: "1000" });
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
  await page.route("**/api/v1/network/job", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), job: "failed", error: "configuration_failed" } });
  });
  await expect(page.locator("#network-job-status")).toHaveText("Network settings could not be applied. Check the current network status before retrying.");
  await page.unroute("**/api/v1/network/job");
  const before = (await counters()).down;
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  await page.getByLabel("Network name (SSID)").fill("Unsubmitted network");
  await page.getByLabel("Local hostname", { exact: true }).fill("kb-unsaved");
  await page.getByRole("button", { name: "Scan networks", exact: true }).click();
  await expect(page.locator("#network-job-status")).toHaveText("Scanning networks");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#network-job-status")).toHaveText("Operation cancelled");
  await expect(page.getByLabel("Join Wi-Fi", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Network name (SSID)")).toHaveValue("Unsubmitted network");
  await expect(page.getByLabel("Local hostname", { exact: true })).toHaveValue("kb-unsaved");
  await page.getByRole("button", { name: "Scan networks", exact: true }).click();
  await expect(page.locator("#wifi-network")).toBeEnabled();
  await expect(page.locator("#wifi-network option")).toHaveCount(6);
  const hostileOption = page.locator("#wifi-network option", { hasText: "Open\\xE2\\x80\\xAE network" });
  await expect(hostileOption).toHaveText("Open\\xE2\\x80\\xAE network (-72 dBm) - unsupported");
  await expect(hostileOption).toBeDisabled();
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
  const revealPassword = async id => {
    const toggle = page.locator(`[data-password-toggle="${id}"]`);
    await toggle.click();
    await expect(page.locator(`#${id}`)).toHaveAttribute("type", "text");
    await expect(toggle.locator(".icon")).toHaveAttribute("data-icon", "eye-off");
    await expect(toggle).toHaveAttribute("aria-label", /^Hide /);
  };
  const expectPasswordHidden = async id => {
    const toggle = page.locator(`[data-password-toggle="${id}"]`);
    await expect(page.locator(`#${id}`)).toHaveAttribute("type", "password");
    await expect(toggle.locator(".icon")).toHaveAttribute("data-icon", "eye");
    await expect(toggle).toHaveAttribute("aria-label", id === "wifi-password" ? "Show Wi-Fi password" : "Show password");
    await expect(toggle).toHaveAttribute("title", await toggle.getAttribute("aria-label"));
  };
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
  await revealPassword("owner-password");
  await page.getByRole("button", { name: "Claim keyboard", exact: true }).click();
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  const key = page.getByRole("button", { name: "A", exact: true });
  await expect(page.locator("#take-control")).toBeVisible();
  await expectPasswordHidden("owner-password");
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
  await page.getByRole("button", { name: "Network settings", exact: true }).click();
  await page.getByLabel("Join Wi-Fi", { exact: true }).check();
  for (const event of ["blur", "pagehide", "visibilitychange"]) {
    await page.getByLabel("Wi-Fi password", { exact: true }).fill("discard-hidden-candidate");
    await revealPassword("wifi-password");
    await page.evaluate(name => {
      if (name === "visibilitychange") {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        try { document.dispatchEvent(new Event(name)); }
        finally { delete document.hidden; }
      } else window.dispatchEvent(new Event(name));
    }, event);
    await expect(page.locator("#wifi-password")).toHaveValue("");
    await expectPasswordHidden("wifi-password");
  }
  await page.getByRole("button", { name: "Back to keyboard", exact: true }).click();
  for (const ending of ["logout", "poll", "session-refresh", "expired-logout"]) {
    await page.getByRole("button", { name: "Network settings", exact: true }).click();
    await page.getByLabel("Join Wi-Fi", { exact: true }).check();
    await page.getByLabel("Wi-Fi password", { exact: true }).fill("discard-this-candidate");
    await revealPassword("wifi-password");
    if (ending === "logout") await page.getByRole("button", { name: "Sign out", exact: true }).click();
    else if (ending === "expired-logout") {
      await page.getByRole("button", { name: "Back to keyboard", exact: true }).click();
      await expectPasswordHidden("wifi-password");
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
    await expectPasswordHidden("wifi-password");
    await expectPasswordHidden("owner-password");
    if (ending === "logout") {
      const rejectLogin = async route => {
        if (route.request().method() === "POST") await route.fulfill({ status: 401, json: { error: "invalid_credentials" } });
        else await route.continue();
      };
      await page.route("**/api/v1/session", rejectLogin);
      await page.getByLabel("Owner password", { exact: true }).fill("incorrect-owner-password");
      await revealPassword("owner-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.locator("#ui-message")).toContainText("Owner password not accepted");
      await expect(page.locator("#owner-password")).toHaveValue("");
      await expectPasswordHidden("owner-password");
      await page.unroute("**/api/v1/session", rejectLogin);
    }
    await page.getByLabel("Owner password", { exact: true }).fill(ownerPassword);
    await revealPassword("owner-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.locator("#take-control")).toBeVisible();
    await expectPasswordHidden("owner-password");
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

test("mock backend records valid states and rejects unauthorized command reports", { timeout: 10000 }, async (context) => {
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

  for (const invalid of [
    { modifiers: 1, keys: [4] }, { modifiers: 8, keys: [21] },
    { modifiers: 3, keys: [44] }, { modifiers: 2, keys: [41] },
    { modifiers: 0, keys: [4, 41] },
  ]) {
    await takeRequest(url, session);
    const rejected = new WebSocket(endpoint, { headers: { Origin: url, Cookie: session.cookie } });
    await once(rejected, "open");
    const rejectedClose = once(rejected, "close");
    rejected.send(JSON.stringify({ v: 1, type: "state", seq: 1, ...invalid }));
    assert.equal((await rejectedClose)[0], 1008);
    assert.equal((await (await fetch(new URL("/__test__/input", url))).json()).connected, false);
  }
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

for (const browserType of [chromium, webkit]) {
  test(`${browserType.name()} Windows Shift separates capitalization from the IME hold gesture`, { timeout: 30000 }, async context => {
    const url = await startPreview(context);
    const browser = await browserType.launch(browserType === webkit ?
      { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const errors = [];
    const states = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
    }));
    const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
    const neutral = { modifiers: 0, keys: [] };
    const expectReports = async (activate, expected) => {
      const start = states.length;
      await activate();
      await expect.poll(() => states.slice(start)).toEqual(expected);
      await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
    };
    await page.goto(url);
    await page.bringToFront();
    await signIn(page);
    await page.getByRole("radio", { name: "Win", exact: true }).tap();
    const shift = page.getByRole("button", { name: "Shift", exact: true });
    const letter = page.getByRole("button", { name: "A", exact: true });

    for (const activate of [() => shift.tap(), () => shift.evaluate(button => button.click())]) {
      await expectReports(async () => {
        const start = states.length;
        await activate();
        await expect(shift).toHaveAttribute("data-shift", "latched");
        await expect(shift).toHaveAttribute("data-held", "false");
        assert.equal(states.length, start);
        await letter.tap();
      }, [{ modifiers: 2, keys: [4] }, neutral]);
      await expect(shift).toHaveAttribute("data-shift", "off");
    }

    await expectReports(() => shift.click({ delay: 1100 }), [{ modifiers: 2, keys: [] }, neutral]);
    await expect(shift).toHaveAttribute("data-shift", "off");
    await expectReports(() => letter.tap(), [{ modifiers: 0, keys: [4] }, neutral]);

    await expectReports(async () => {
      await shift.hover();
      await page.mouse.down();
      await expect(shift).toHaveAttribute("data-held", "true");
      await expect(shift).toHaveAttribute("data-shift", "off");
      await expect(shift).toHaveAttribute("aria-pressed", "true");
      await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
      await expect(letter).toHaveText("A");
      await page.keyboard.press("a", { delay: 1100 });
      await page.mouse.up();
    }, [{ modifiers: 2, keys: [4] }, neutral]);
    await expect(shift).toHaveAttribute("data-shift", "off");
    await expect(shift).toHaveAttribute("data-held", "false");

    await expectReports(() => shift.dblclick({ delay: 60 }), [{ modifiers: 0, keys: [57] }, neutral]);
    await expect(page.locator("#caps-status")).toHaveText("Caps on");
    await expectReports(() => shift.tap(), [{ modifiers: 0, keys: [57] }, neutral]);
    await expect(page.locator("#caps-status")).toHaveText("Caps off");

    await page.locator("#keyboard").focus();
    await expectReports(() => page.keyboard.press("ShiftLeft"), [{ modifiers: 2, keys: [] }, neutral]);
    await page.getByRole("radio", { name: "iOS", exact: true }).tap();
    await expectReports(() => shift.tap(), [{ modifiers: 2, keys: [] }, neutral]);
    await expect(shift).toHaveAttribute("data-shift", "latched");
    await expectReports(() => letter.tap(), [{ modifiers: 2, keys: [4] }, neutral]);
    await page.getByRole("radio", { name: "Win", exact: true }).tap();

    const beforeCancel = states.length;
    await shift.hover();
    await page.mouse.down();
    const heldSince = Date.now();
    await expect.poll(() => Date.now() - heldSince).toBeGreaterThanOrEqual(1000);
    await shift.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
    await page.mouse.up();
    await expect(letter).toBeDisabled();
    await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
    assert.equal(states.slice(beforeCancel).some(state => state.modifiers === 2 && state.keys.length === 0), false);
    assert.deepEqual(errors, []);
  });

  test(`${browserType.name()} Host changes cancel Shift holds, latches and typing`, { timeout: 30000 }, async context => {
    const url = await startPreview(context);
    const browser = await browserType.launch(browserType === webkit ?
      { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const errors = [];
    const states = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
    }));
    const neutral = { modifiers: 0, keys: [] };
    const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
    const expectReports = async (activate, expected) => {
      const start = states.length;
      await activate();
      await expect.poll(() => states.slice(start)).toEqual(expected);
      await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
    };
    await page.goto(url);
    await page.bringToFront();
    await signIn(page);
    const shift = page.getByRole("button", { name: "Shift", exact: true });
    const letter = page.getByRole("button", { name: "A", exact: true });
    for (const [from, to] of [["Win", "iOS"], ["iOS", "Win"]]) {
      const originalHost = page.getByRole("radio", { name: from, exact: true });
      const nextHost = page.getByRole("radio", { name: to, exact: true });
      await originalHost.tap();
      await expectReports(async () => {
        await shift.hover();
        await page.mouse.down();
        await expect(shift).toHaveAttribute("data-held", "true");
        const heldSince = Date.now();
        await expect.poll(() => Date.now() - heldSince).toBeGreaterThanOrEqual(1000);
        await nextHost.evaluate(input => input.click());
        await expect(nextHost).toBeChecked();
        await expect(shift).toHaveAttribute("data-held", "false");
        await expect(shift).toHaveAttribute("data-shift", "off");
        await page.mouse.up();
      }, from === "iOS" ? [{ modifiers: 2, keys: [] }, neutral] : []);
      await expectReports(() => letter.tap(), [{ modifiers: 0, keys: [4] }, neutral]);

      await expectReports(async () => {
        await shift.tap();
        await expect(shift).toHaveAttribute("data-shift", "latched");
        await originalHost.tap();
        await expect(shift).toHaveAttribute("data-shift", "off");
        await expect(shift).toHaveAttribute("data-held", "false");
        await letter.tap();
      }, [...(to === "iOS" ? [{ modifiers: 2, keys: [] }, neutral] : []),
        { modifiers: 0, keys: [4] }, neutral]);

      await expectReports(async () => {
        await page.locator("#keyboard").focus();
        await page.keyboard.down("a");
        await expect.poll(counters).toMatchObject({ report: { modifiers: 0, keys: [4] } });
        await nextHost.tap();
        await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
        await page.keyboard.up("a");
      }, [{ modifiers: 0, keys: [4] }, neutral]);
      await expect(letter).toBeEnabled();
    }
    await page.evaluate(() => localStorage.setItem("keyboard.host-profile.v1", "macos"));
    await page.reload();
    await takeControl(page);
    const globe = page.getByRole("button", { name: "Switch input source" });
    await expect(shift).toBeDisabled();
    await expect(globe).toBeDisabled();
    await expectReports(async () => {
      await shift.evaluate(button => button.click());
      await globe.evaluate(button => button.click());
    }, []);
    await expectReports(() => letter.tap(), [{ modifiers: 0, keys: [4] }, neutral]);
    await page.getByRole("radio", { name: "Win", exact: true }).tap();
    await expect(shift).toBeEnabled();
    await expectReports(async () => {
      await shift.tap();
      await expect(shift).toHaveAttribute("data-shift", "latched");
      await letter.tap();
    }, [{ modifiers: 2, keys: [4] }, neutral]);
    assert.deepEqual(errors, []);
  });

  test(`${browserType.name()} ignored physical keys cancel Windows Shift gestures`, { timeout: 30000 }, async context => {
    const url = await startPreview(context);
    const browser = await browserType.launch(browserType === webkit ?
      { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    const errors = [];
    const states = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", socket => socket.on("framesent", frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
    }));
    const neutral = { modifiers: 0, keys: [] };
    const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
    await page.goto(url);
    await page.bringToFront();
    await signIn(page);
    await page.getByRole("radio", { name: "Win", exact: true }).tap();
    const shift = page.getByRole("button", { name: "Shift", exact: true });
    const letter = page.getByRole("button", { name: "A", exact: true });
    for (const code of ["Escape", "ArrowLeft", "F1", "ControlLeft", "AltLeft", "MetaLeft"]) {
      const start = states.length;
      await shift.hover();
      await page.mouse.down();
      await expect(shift).toHaveAttribute("data-held", "true");
      await page.keyboard.press(code, { delay: 1100 });
      await page.mouse.up();
      await expect(shift).toHaveAttribute("data-held", "false");
      await expect(shift).toHaveAttribute("data-shift", "off");
      await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
      assert.deepEqual(states.slice(start), []);
      if (["ControlLeft", "AltLeft", "MetaLeft"].includes(code)) {
        await expect(letter).toBeDisabled();
        await takeControl(page);
      } else {
        await expect(letter).toBeEnabled();
      }
      await letter.tap();
      await expect.poll(() => states.slice(start)).toEqual([{ modifiers: 0, keys: [4] }, neutral]);
    }
    assert.deepEqual(errors, []);
  });
}

test("Globe and Cancel preserve profiles and send isolated report sequences", { timeout: 20000 }, async context => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const states = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
  }));
  const report = async () => (await (await fetch(new URL("/__test__/input", url))).json()).report;
  const neutral = { modifiers: 0, keys: [] };
  const expectCommand = async (button, command, activate = () => button.click()) => {
    const start = states.length;
    await activate();
    await expect.poll(() => states.length).toBe(start + 3);
    assert.deepEqual(states.slice(start), [neutral, command, neutral]);
    await expect.poll(report).toEqual(neutral);
  };
  const expectKeyboardCommand = async (button, key, command) => {
    await button.focus();
    const start = states.length;
    await page.keyboard.down(key);
    await expect.poll(() => states.length).toBe(start + 3);
    await button.dispatchEvent("keydown", { key: key === "Space" ? " " : key, code: key, repeat: true });
    await page.keyboard.up(key);
    assert.equal(states.length, start + 3);
    assert.deepEqual(states.slice(start), [neutral, command, neutral]);
    await expect.poll(report).toEqual(neutral);
  };

  await page.goto(url);
  const hostProfile = page.locator("#host-profile");
  const iosHost = hostProfile.locator('input[value="ios"]');
  const windowsHost = hostProfile.locator('input[value="windows"]');
  await expect(iosHost).toBeChecked();
  await expect(page.locator(".keyboard-meta")).toContainText("Key map: US ANSI");
  assert.equal(await page.evaluate(() => localStorage.getItem("keyboard.host-profile.v1")), null);
  await signIn(page);

  await expect(page.getByRole("radiogroup", { name: "Host", exact: true })).toBeVisible();
  await expect(windowsHost).toHaveAccessibleName("Win");
  const beforeToggles = states.length;
  await windowsHost.click();
  await expect(windowsHost).toBeChecked();
  await expect(iosHost).not.toBeChecked();
  await iosHost.tap();
  await expect(iosHost).toBeChecked();
  await iosHost.focus();
  await page.keyboard.press("ArrowRight");
  await expect(windowsHost).toBeChecked();
  await page.keyboard.press("Space");
  await expect(windowsHost).toBeChecked();
  await page.keyboard.press("ArrowLeft");
  await expect(iosHost).toBeChecked();
  assert.equal(states.length, beforeToggles);
  assert.equal(await page.evaluate(() => localStorage.getItem("keyboard.host-profile.v1")), "ios");

  await page.locator("#keyboard").focus();
  await page.keyboard.down("Shift");
  await page.keyboard.down("a");
  await expect.poll(report).toEqual({ modifiers: 2, keys: [4] });
  await expect.poll(() => states.at(-1)).toEqual({ modifiers: 2, keys: [4] });
  const globe = page.getByRole("button", { name: "Switch input source" });
  const cancel = page.getByRole("button", { name: "Cancel (Escape)" });
  await expectCommand(globe, { modifiers: 1, keys: [44] }, () => globe.tap());
  await page.keyboard.up("a");
  await page.keyboard.up("Shift");

  const beforeProfileChange = states.length;
  await windowsHost.click();
  assert.equal(states.length, beforeProfileChange);
  assert.equal(await page.evaluate(() => localStorage.getItem("keyboard.host-profile.v1")), "windows");
  await expectCommand(globe, { modifiers: 8, keys: [44] });
  await expectKeyboardCommand(cancel, "Space", { modifiers: 0, keys: [41] });
  await expectKeyboardCommand(globe, "Enter", { modifiers: 8, keys: [44] });
  const beforeModifiedCommands = states.length;
  await cancel.focus();
  for (const shortcut of ["Control+Space", "Alt+Enter", "Meta+Space"]) {
    await page.keyboard.press(shortcut);
  }
  assert.equal(states.length, beforeModifiedCommands);
  await page.keyboard.down("Shift");
  await page.keyboard.press("Space");
  await page.keyboard.up("Shift");
  await expect.poll(() => states.length).toBe(beforeModifiedCommands + 4);
  assert.deepEqual(states.slice(beforeModifiedCommands), [
    { modifiers: 2, keys: [] }, { modifiers: 2, keys: [44] },
    { modifiers: 2, keys: [] }, neutral,
  ]);
  await expect(page.locator(".keyboard-meta")).toContainText("Key map: US ANSI");

  await page.reload();
  await expect(windowsHost).toBeChecked();
  const beforeReconnect = states.length;
  await takeControl(page);
  assert.equal(states.length, beforeReconnect);

  await page.evaluate(() => localStorage.setItem("keyboard.host-profile.v1", "macos"));
  await page.reload();
  await expect(hostProfile.locator("input:checked")).toHaveCount(0);
  await expect(hostProfile).toHaveAttribute("aria-invalid", "true");
  await expect(globe).toBeDisabled();
  await takeControl(page);
  await expect(globe).toBeDisabled();
  const beforeBlockedGlobe = states.length;
  await globe.evaluate(button => button.click());
  assert.equal(states.length, beforeBlockedGlobe);

  await iosHost.tap();
  await expect(iosHost).toBeChecked();
  await expect(hostProfile).toHaveAttribute("aria-invalid", "false");
  await page.locator("#keyboard").focus();
  const beforePhysicalShortcuts = states.length;
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Escape");
  assert.equal(states.length, beforePhysicalShortcuts);
});

test("rotation clears input without changing page or host profile", { timeout: 20000 }, async context => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const states = [];
  page.on("websocket", socket => socket.on("framesent", frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
  }));
  const report = async () => (await (await fetch(new URL("/__test__/input", url))).json()).report;
  const neutral = { modifiers: 0, keys: [] };
  await page.goto(url);
  await signIn(page);
  await page.getByRole("radio", { name: "Win", exact: true }).click();

  const selectPage = async mode => {
    let current = await page.locator("#key-rows").getAttribute("data-page");
    if (mode === "letters" && current !== mode) {
      await page.getByRole("button", { name: "ABC", exact: true }).click();
    } else if (mode === "numbers" && current === "letters") {
      await page.getByRole("button", { name: "123", exact: true }).click();
    } else if (mode === "numbers" && current === "symbols") {
      await page.getByRole("button", { name: "123", exact: true }).click();
    } else if (mode === "symbols") {
      if (current === "letters") await page.getByRole("button", { name: "123", exact: true }).click();
      current = await page.locator("#key-rows").getAttribute("data-page");
      if (current === "numbers") await page.getByRole("button", { name: "#+=", exact: true }).click();
    }
    await expect(page.locator("#key-rows")).toHaveAttribute("data-page", mode);
  };

  for (const mode of ["letters", "numbers", "symbols"]) {
    await selectPage(mode);
    for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
      await page.locator("#keyboard").focus();
      await page.keyboard.down("Shift");
      await page.keyboard.down("a");
      await expect.poll(report).toEqual({ modifiers: 2, keys: [4] });
      await expect.poll(() => states.at(-1)).toEqual({ modifiers: 2, keys: [4] });
      const beforeRotation = states.length;
      await page.setViewportSize(viewport);
      await expect.poll(report).toEqual(neutral);
      await expect.poll(() => states.length).toBe(beforeRotation + 1);
      assert.deepEqual(states[beforeRotation], neutral);
      await expect(page.locator("#key-rows")).toHaveAttribute("data-page", mode);
      await expect(page.getByRole("radio", { name: "Win", exact: true })).toBeChecked();
      await page.keyboard.up("a");
      await page.keyboard.up("Shift");
    }
  }
  assert.equal(states.some(state => state.keys.includes(41) || state.modifiers === 1 || state.modifiers === 8), false);
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

test("local echo is opt-in, passive, clearable and remembers only the setting", { timeout: 20000 }, async context => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  await page.goto(url);
  await signIn(page);
  const toggle = page.getByRole("switch", { name: "Local echo", exact: true });
  const echo = page.locator("#local-echo-text");
  const counters = async () => (await (await fetch(new URL("/__test__/input", url))).json());
  await expect(toggle).not.toBeChecked();
  await expect(page.locator("#local-echo-window")).toBeHidden();
  await page.keyboard.type("private", { delay: 20 });
  await expect(echo).toHaveText("");
  const before = await counters();
  await toggle.check();
  await expect(page.locator("#local-echo-window")).toBeVisible();
  assert.equal((await counters()).down, before.down);
  await page.locator("#keyboard").focus();
  await page.keyboard.press("Shift+KeyH");
  await page.keyboard.type("ello, remote.", { delay: 20 });
  await expect(echo).toHaveText("Hello, remote.");
  await page.keyboard.press("Backspace");
  await expect(echo).toHaveText("Hello, remote");
  await page.getByRole("button", { name: "Return", exact: true }).tap();
  await expect(echo).toHaveText("");
  await page.keyboard.type("clear me", { delay: 20 });
  await expect(echo).toHaveText("clear me");
  const beforeClear = await counters();
  await page.getByRole("button", { name: "Clear local echo", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(echo).toHaveText("");
  assert.equal((await counters()).down, beforeClear.down);
  await page.keyboard.type("temporary", { delay: 20 });
  await expect(echo).toHaveText("temporary");
  await toggle.uncheck();
  await expect(echo).toHaveText("");
  await toggle.check();
  await expect(echo).toHaveText("");
  assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), { "keyboard.local-echo.v1": "true" });
  assert.equal(await echo.evaluate(element => element.isContentEditable), false);
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(echo).toHaveText("");
  await toggle.uncheck();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => localStorage.setItem("keyboard.local-echo.v1", "invalid"));
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); };
  });
  await toggle.check();
  await expect(page.locator("#local-echo-window")).toBeVisible();
  await expect(page.locator("#ui-message")).toHaveText("Local echo preference could not be saved.");
});

test("local echo applies only acknowledged edits and never revives cleared pending text", { timeout: 20000 }, async context => {
  const url = await startPreview(context);
  const browser = await chromium.launch();
  context.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(() => {
    window.deferEchoAcks = false;
    window.echoReplies = [];
    const listen = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (type, callback, options) {
      if (type !== "message") return listen.call(this, type, callback, options);
      return listen.call(this, type, event => {
        if (window.deferEchoAcks && JSON.parse(event.data).type === "queued") {
          window.echoReplies.push(() => callback.call(this, event));
        } else callback.call(this, event);
      }, options);
    };
  });
  await page.goto(url);
  await signIn(page);
  await page.getByRole("switch", { name: "Local echo", exact: true }).check();
  const echo = page.locator("#local-echo-text");
  for (const [action, code, expected] of [["deliver", "KeyA", "a"], ["deliver", "KeyB", "ab"],
    ["deliver", "Backspace", "a"], ["deliver", "Enter", ""], ["clear", "KeyA", ""], ["toggle", "KeyA", ""]]) {
    await page.locator("#keyboard").focus();
    const before = await echo.textContent();
    await page.evaluate(() => { window.deferEchoAcks = true; });
    await page.keyboard.press(code);
    await page.waitForFunction(() => window.echoReplies.length === 2);
    const observed = await page.evaluate(action => {
      const beforeReply = document.querySelector("#local-echo-text").textContent;
      if (action === "clear") document.querySelector("#local-echo-clear").click();
      if (action === "toggle") {
        document.querySelector("#local-echo-toggle").click();
        document.querySelector("#local-echo-toggle").click();
      }
      window.deferEchoAcks = false;
      for (const reply of window.echoReplies.splice(0)) reply();
      return beforeReply;
    }, action);
    assert.equal(observed, before);
    await expect(echo).toHaveText(expected);
    await expect(page.getByRole("button", { name: "A", exact: true })).toBeEnabled();
  }
  await page.locator("#keyboard").focus();
  await page.keyboard.press("KeyB");
  await expect(echo).toHaveText("b");
});

for (const [engineName, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
  test(`${engineName} local echo supports keyboard-only scrolling without remote input`, { timeout: 25000 }, async context => {
    const url = await startPreview(context);
    const browser = await engine.launch(engineName === "WebKit" ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 844, height: 390 } });
    page.setDefaultTimeout(5000);
    const counters = async () => (await (await fetch(new URL("/__test__/input", url))).json());
    await page.goto(url);
    await signIn(page);
    const toggle = page.getByRole("switch", { name: "Local echo", exact: true });
    const echo = page.locator("#local-echo-text");
    await toggle.check();
    await page.locator("#keyboard").focus();
    const text = "abcdefghij".repeat(8);
    await page.keyboard.type(text, { delay: 20 });
    await expect(echo).toHaveText(text);
    await expect.poll(counters).toMatchObject({ down: text.length, up: text.length, queued: text.length * 2 });
    const before = await counters();
    await toggle.focus();
    await page.keyboard.press("Tab");
    await expect(echo).toBeFocused();
    assert.equal(await echo.evaluate(element => element.isContentEditable), false);
    assert.equal(await echo.evaluate(element => getComputedStyle(element).outlineStyle), "solid");
    const scrollLeft = await echo.evaluate(element => element.scrollLeft);
    assert.ok(scrollLeft > 0);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => echo.evaluate(element => element.scrollLeft)).toBeLessThan(scrollLeft);
    await page.keyboard.press("Space");
    await page.keyboard.press("Enter");
    await page.keyboard.type("local", { delay: 20 });
    await expect(echo).toHaveText(text);
    assert.deepEqual(await counters(), before);
    const screenshots = new URL("../.cache/tests/", import.meta.url);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: fileURLToPath(new URL(`local-echo-${engineName.toLowerCase()}-focus.png`, screenshots)) });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Clear local echo", exact: true })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(echo).toHaveText("");
    assert.deepEqual(await counters(), before);
    await page.getByRole("button", { name: "A", exact: true }).tap();
    await expect(echo).toHaveText("a");
  });

  test(`${engineName} local echo preserves input semantics and erases text on lifecycle exits`, { timeout: 25000 }, async context => {
    const url = await startPreview(context);
    const browser = await engine.launch(engineName === "WebKit" ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {});
    context.after(() => browser.close());
    const page = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await signIn(page);
    await page.getByRole("switch", { name: "Local echo", exact: true }).check();
    const echo = page.locator("#local-echo-text");
    const letter = page.getByRole("button", { name: "A", exact: true });
    await page.locator("#keyboard").focus();
    await page.keyboard.down("a");
    await expect(echo).toHaveText("a");
    await page.keyboard.down("a");
    await letter.tap();
    await expect(echo).toHaveText("a");
    await page.keyboard.up("a");
    await letter.tap();
    await expect(echo).toHaveText("aa");
    await echo.dispatchEvent("pointercancel", { pointerId: 99, pointerType: "touch", bubbles: true });
    await expect(echo).toHaveText("aa");
    await expect(letter).toBeEnabled();
    for (const name of ["Switch input source", "Cancel (Escape)"]) {
      await page.getByRole("button", { name, exact: true }).tap();
      await expect(echo).toHaveText("aa");
    }
    await page.getByRole("button", { name: "123", exact: true }).tap();
    await page.getByRole("button", { name: "?", exact: true }).tap();
    await expect(echo).toHaveText("aa?");
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(echo).toHaveText("aa?");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(echo).toHaveText("aa?");
    await page.getByRole("button", { name: "ABC", exact: true }).tap();
    for (const event of ["release", "blur", "pagehide", "visibilitychange", "network", "logout"]) {
      await letter.tap();
      await expect(echo).not.toHaveText("");
      if (event === "release") await page.getByRole("button", { name: "Release all keys", exact: true }).click();
      else if (event === "network") await page.getByRole("button", { name: "Network settings", exact: true }).click();
      else if (event === "logout") await page.getByRole("button", { name: "Sign out", exact: true }).click();
      else await page.evaluate(event => {
        if (event === "visibilitychange") {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event(event));
          delete document.hidden;
        } else window.dispatchEvent(new Event(event));
      }, event);
      await expect(echo).toHaveText("");
      if (event === "logout") break;
      if (event === "network") await page.getByRole("button", { name: "Back to keyboard", exact: true }).click();
      await takeControl(page);
      await expect(echo).toHaveText("");
    }
    assert.deepEqual(errors, []);
  });
}

test("all keyboard pages fit phone, tablet and desktop viewports without overlapping keys", { timeout: 45000 }, async (context) => {
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
  for (const [width, height, echoEnabled] of [[320, 568], [375, 667], [390, 844], [430, 932], [568, 320],
    [844, 390], [768, 1024], [1024, 768], [1366, 768], [1920, 1080]].flatMap(viewport => [[...viewport, false], [...viewport, true]])) {
    await page.setViewportSize({ width, height });
    await page.getByRole("switch", { name: "Local echo", exact: true }).setChecked(echoEnabled);
    if (echoEnabled) {
      await page.locator("#keyboard").focus();
      const text = width === 1920 ? "w".repeat(280) : "hello, remote.";
      await page.keyboard.type(text, { delay: 20 });
      await expect(page.locator("#local-echo-text")).toHaveText(text.slice(-256));
    }
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
        const metadata = [...document.querySelectorAll(".keyboard-meta > span, .host-profile-field, .echo-toggle")];
        const metaBounds = metadata.map(element => element.getBoundingClientRect());
        metadata.forEach((element, index) => {
          const box = metaBounds[index];
          if (box.left < 0 || box.right > innerWidth || box.top < header.bottom) problems.push("metadata bounds");
          if (element.scrollWidth > element.clientWidth + 1) problems.push("metadata label overflow");
          for (const next of metaBounds.slice(index + 1)) {
            if (box.left < next.right && box.right > next.left && box.top < next.bottom && box.bottom > next.top) problems.push("metadata overlap");
          }
        });
        for (const segment of document.querySelectorAll("#host-profile label")) {
          if (segment.getBoundingClientRect().width < 44) problems.push("host toggle target");
          if (segment.scrollWidth > segment.clientWidth + 1) problems.push("host toggle label overflow");
        }
        const bounds = keys.map(button => button.getBoundingClientRect());
        const echo = document.querySelector("#local-echo-window");
        if (!echo.hidden) {
          const box = echo.getBoundingClientRect();
          if (box.left < 0 || box.right > innerWidth || box.top < header.bottom || box.bottom > bounds[0].top) problems.push("echo bounds");
          for (const other of metaBounds) {
            if (box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top) problems.push("echo metadata overlap");
          }
          const text = document.querySelector("#local-echo-text").getBoundingClientRect();
          const clear = document.querySelector("#local-echo-clear").getBoundingClientRect();
          if (text.right > clear.left || text.top < box.top || text.bottom > box.bottom) problems.push("echo content bounds");
          if (clear.width < 44 || clear.height < 44) problems.push("echo clear target");
        }
        const toggle = document.querySelector(".echo-toggle").getBoundingClientRect();
        if (toggle.width < 44 || toggle.height < 44) problems.push("echo toggle target");
        keys.forEach((button, index) => {
          const box = bounds[index];
          const utility = ["globe", "cancel"].includes(button.dataset.action);
          if (box.width < (utility ? 44 : 27) || box.height < 44) problems.push(`target:${button.getAttribute("aria-label")}`);
          if (box.left < 0 || box.right > innerWidth || box.top < header.bottom || box.bottom > footer.top) problems.push("bounds");
          if (button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1) problems.push("label overflow");
          for (let other = index + 1; other < bounds.length; other++) {
            const next = bounds[other];
            if (box.left < next.right && box.right > next.left && box.top < next.bottom && box.bottom > next.top) problems.push("overlap");
          }
        });
        const controlKeys = keys.filter(button => button.closest(".controls"));
        const controls = {
          globe: controlKeys.filter(button => button.dataset.action === "globe"),
          mode: controlKeys.filter(button => button.dataset.action === "page"),
          space: controlKeys.filter(button => button.dataset.code === "Space"),
          return: controlKeys.filter(button => button.dataset.code === "Enter"),
          cancel: controlKeys.filter(button => button.dataset.action === "cancel"),
        };
        if (Object.values(controls).some(matches => matches.length !== 1)) problems.push("control count");
        else {
          const controlBounds = Object.fromEntries(Object.entries(controls).map(([name, matches]) => [name, matches[0].getBoundingClientRect()]));
          if (innerWidth > innerHeight) {
            const ordered = [controlBounds.globe, controlBounds.mode, controlBounds.space, controlBounds.return, controlBounds.cancel];
            if (ordered.some((box, index) => index && box.left <= ordered[index - 1].left)) problems.push("landscape control order");
            if (Math.max(...ordered.map(box => box.top)) - Math.min(...ordered.map(box => box.top)) > 1) problems.push("landscape control row");
          } else {
            if (Math.abs(controlBounds.mode.top - controlBounds.space.top) > 1 || Math.abs(controlBounds.space.top - controlBounds.return.top) > 1) problems.push("portrait keycap row");
            if (Math.abs(controlBounds.globe.top - controlBounds.cancel.top) > 1 || controlBounds.globe.top < controlBounds.mode.bottom) problems.push("portrait utility strip");
          }
        }
        return { problems, width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight, viewportHeight: innerHeight };
      });
      assert.deepEqual(layout.problems, [], `${width}x${height} ${mode} echo=${echoEnabled}`);
      assert.ok(layout.width <= width, `Horizontal scrolling at ${width}x${height} ${mode}`);
      assert.ok(layout.height <= layout.viewportHeight + 1, `Vertical scrolling at ${width}x${height} ${mode}: ${layout.height}`);
      if ([320, 390, 568, 768, 1366].includes(width)) {
        await page.screenshot({ path: fileURLToPath(new URL(`keyboard-${width}-${mode}${echoEnabled ? "-echo" : ""}.png`, screenshots)) });
      }
    }
  }
  for (const icon of ["shift", "caps", "backspace", "return", "release", "globe", "x"]) {
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
  await page.getByRole("switch", { name: "Local echo", exact: true }).check();
  for (const fault of ["buffered", "ack", "send"]) {
    const baseline = await counters();
    await page.locator("#keyboard").focus();
    await page.evaluate(fault => { window.transportFault = fault; }, fault);
    await page.keyboard.down("a");
    await expect(key).toBeDisabled();
    await expect(page.locator("#local-echo-text")).toHaveText("");
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

test("WebKit types and sends Globe and Cancel across iPhone layouts", { timeout: 20000 }, async (context) => {
  const url = await startPreview(context);
  const browser = await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE_PATH });
  context.after(() => browser.close());
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const errors = [];
  const states = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => socket.on("framesent", frame => {
    const message = JSON.parse(String(frame.payload));
    if (message.type === "state") states.push({ modifiers: message.modifiers, keys: message.keys });
  }));
  const counters = async () => (await fetch(new URL("/__test__/input", url))).json();
  const neutral = { modifiers: 0, keys: [] };
  const tapCommand = async (button, command) => {
    await expect.poll(() => states.at(-1)).toEqual(neutral);
    const start = states.length;
    await button.tap();
    await expect.poll(() => states.length).toBe(start + 3);
    assert.deepEqual(states.slice(start), [neutral, command, neutral]);
    await expect.poll(counters).toMatchObject({ report: neutral, pressed: false });
  };
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
  await expect(page.getByRole("radio", { name: "iOS", exact: true })).toBeChecked();
  const globe = page.getByRole("button", { name: "Switch input source" });
  const cancel = page.getByRole("button", { name: "Cancel (Escape)" });
  await tapCommand(globe, { modifiers: 1, keys: [44] });
  await tapCommand(cancel, { modifiers: 0, keys: [41] });
  const beforeHostToggle = states.length;
  await page.getByRole("radio", { name: "Win", exact: true }).tap();
  await expect(page.getByRole("radio", { name: "Win", exact: true })).toBeChecked();
  assert.equal(states.length, beforeHostToggle);
  await tapCommand(globe, { modifiers: 8, keys: [44] });
  await expect.poll(counters).toMatchObject({ down: 7, up: 7, pressed: false });
  assert.ok(await page.locator('[data-code="Backspace"] .icon').evaluate(element => getComputedStyle(element).maskImage !== "none"));
  assert.ok(await globe.locator(".icon").evaluate(element => getComputedStyle(element).maskImage !== "none"));
  assert.ok(await cancel.locator(".icon").evaluate(element => getComputedStyle(element).maskImage !== "none"));
  await page.screenshot({ path: fileURLToPath(new URL("../.cache/tests/keyboard-webkit-phone.png", import.meta.url)) });
  await page.setViewportSize({ width: 844, height: 390 });
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assert.ok(layout.width <= 844 && layout.height <= 390);
  await expect(page.getByRole("radio", { name: "Win", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Return", exact: true }).tap();
  await expect.poll(counters).toMatchObject({ down: 8, up: 8, pressed: false });
  assert.deepEqual(errors, []);
});