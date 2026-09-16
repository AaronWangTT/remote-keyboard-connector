import { createServer } from "node:http";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseTree } from "jsonc-parser";
import { WebSocket, WebSocketServer } from "ws";
import { passwordIterations } from "./provision-device.mjs";

const usbReady = process.env.PREVIEW_USB_READY !== "0";
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 });
let capsLock = process.env.PREVIEW_CAPS_LOCK === "unknown" ? null : process.env.PREVIEW_CAPS_LOCK === "1";
let controller = null;
const receipts = { down: 0, up: 0, stop: 0, queued: 0, forced_release: 0 };
let claimed = process.env.PREVIEW_CLAIMED !== "0";
const ownerSalt = randomBytes(16);
const passwordHash = password => pbkdf2Sync(password, ownerSalt, passwordIterations, 32, "sha256");
let ownerHash = passwordHash(process.env.PREVIEW_OWNER_PASSWORD ?? "preview-owner-password");
const setupCode = "0123456789abcdef01234567";
const sessions = new Map();
const drainingRequests = new WeakSet();
let pendingControl = null;
let loginWindow = 0;
let loginAttempts = 0;
const network = { available: true, ap_active: true, station_online: false, desired_station: false,
  has_profile: false, busy: false, mdns: true,
  get can_control() { return this.available && !this.busy && !updateBusy() && pendingControl === null && controller?.readyState !== WebSocket.OPEN; },
  job_id: 0, phase: "ap", job: "idle", error: "",
  hostname: "kb", requested_hostname: "kb", ap_ssid: "WiFiKeyboard-123456", saved_ssid: "", saved_ssid_hex: "", station_ssid: "",
  ap_ip: "192.168.4.1", ap_reconnect_ip: "", station_ip: "", scan: [] };
let pendingProfile = null;
const networkDelay = Math.max(50, Number(process.env.PREVIEW_NETWORK_DELAY_MS) || 200);
const scanTtl = Math.max(50, Number(process.env.PREVIEW_SCAN_TTL_MS) || 30000);
const confirmationTtl = Math.max(100, Number(process.env.PREVIEW_CONFIRM_TTL_MS) || 60000);
const storageFault = process.env.PREVIEW_STORAGE_FAULT === "1";
let confirmationUntil = 0;
let managementUntil = 0;
let firmwareVersion = "0.1.0";
let updateJob = { job_id: 0, phase: "idle", received: 0, expected: 0, candidate_version: "", sha256: "", error: "" };
let updateOwner = null;
let uploadActive = false;
let updateDeadline = 0;
let updateLastProgress = 0;
const updateDelay = Math.max(10, Number(process.env.PREVIEW_UPDATE_DELAY_MS) || 200);
const updateStagedTtl = Math.max(100, Number(process.env.PREVIEW_UPDATE_STAGED_MS) || 120000);
if (process.env.PREVIEW_NETWORK_MODE === "station") Object.assign(network, {
  ap_active: false, ap_ip: "", station_online: true, station_ip: "192.168.1.50", desired_station: true,
  has_profile: true, phase: "station", saved_ssid: "Home Wi-Fi", station_ssid: "Home Wi-Fi" });

function updateBusy() {
  return uploadActive || ["receiving", "verifying", "staged", "activating"].includes(updateJob.phase);
}

function firmwareInfo() {
  return { version: firmwareVersion, board: "esp32s3-generic-16m", layout: "kb16-ab6-nvs64-v1", source: "0".repeat(40),
    test_only: true, available: true, trial_boot: false, busy: updateBusy(), max_bytes: 0x4cc000 };
}

function cancelUpdate() {
  if (!["receiving", "verifying", "staged"].includes(updateJob.phase)) return false;
  Object.assign(updateJob, { phase: "cancelled", error: "cancelled" });
  return true;
}

async function updateRequest(request, response) {
  const session = authorized(request, response, request.method !== "GET");
  if (!session) return;
  if (request.url === "/api/v1/firmware" && request.method === "GET") return sendJson(response, 200, firmwareInfo());
  if (request.url === "/api/v1/update" && request.method === "POST") {
    if (controller?.readyState === WebSocket.OPEN || pendingControl) return sendJson(response, 409, { error: "release_control_first" });
    if (updateBusy() || network.busy || !network.available) return sendJson(response, 409, { error: "update_unavailable_or_busy" });
    const expected = Number(request.headers["content-length"]);
    if (request.headers["content-type"] !== "application/octet-stream" || request.headers["transfer-encoding"] ||
        !Number.isSafeInteger(expected) || expected < 8192 || expected > 0x4cc000 || expected % 4096) {
      return sendJson(response, 400, { error: "invalid_update_request" });
    }
    const current = updateJob = { job_id: updateJob.job_id + 1, phase: "receiving", received: 0, expected,
      candidate_version: "", sha256: "", error: "" };
    updateOwner = session;
    uploadActive = true;
    updateDeadline = performance.now() + 300000;
    updateLastProgress = performance.now();
    const chunks = [];
    try {
      for await (const chunk of request) {
        if (current.phase !== "receiving" || current.received + chunk.length > expected) throw new Error("cancelled");
        current.received += chunk.length;
        updateLastProgress = performance.now();
        chunks.push(chunk);
      }
      if (current.received !== expected || current.phase !== "receiving") throw new Error("incomplete");
      current.phase = "verifying";
      await new Promise(resolve => setTimeout(resolve, updateDelay));
      const data = Buffer.concat(chunks);
      const field = offset => data.subarray(offset, offset + 32).toString("ascii").split("\0")[0];
      const version = field(0x120 + 184);
      const parts = value => value.split(".").map(Number);
      const next = parts(version), previous = parts(firmwareVersion);
      const difference = next.findIndex((value, index) => value !== previous[index]);
      if (current.phase !== "verifying" || process.env.PREVIEW_UPDATE_FAIL === "signature" || data[0] !== 0xe9 ||
          data.subarray(0x120, 0x128).toString() !== "KBOTA001" || field(0x120 + 72) !== firmwareInfo().board ||
          field(0x120 + 104) !== firmwareInfo().layout ||
          !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || next.some(value => value > 65535) ||
          difference < 0 || next[difference] <= previous[difference] || data[expected - 4096] !== 0xe7) throw new Error("invalid_image");
      Object.assign(current, { phase: "staged", candidate_version: version, sha256: createHash("sha256").update(data).digest("hex") });
      updateDeadline = performance.now() + updateStagedTtl;
      uploadActive = false;
      return sendJson(response, 200, { ...firmwareInfo(), ...current });
    } catch {
      if (current.phase !== "cancelled") Object.assign(current, { phase: "failed", error: "invalid_or_incomplete_image" });
      uploadActive = false;
      if (!response.destroyed) sendJson(response, 400, { error: "update_failed" });
      return;
    }
  }
  if (updateJob.job_id !== 0 && session !== updateOwner) return sendJson(response, 403, { error: "update_owner_required" });
  if (request.url === "/api/v1/update/job" && request.method === "GET") return sendJson(response, 200, { ...firmwareInfo(), ...updateJob });
  const activation = request.url === "/api/v1/update/activate" && request.method === "POST";
  if (!activation && !(request.url === "/api/v1/update/job" && request.method === "DELETE")) return sendJson(response, 405, {});
  const command = await jsonBody(request, { numbers: true, maximum: 192 });
  if (!command || Object.keys(command).length !== (activation ? 2 : 1) || !Number.isInteger(command.job_id) ||
      command.job_id < 1 || (activation && !/^[a-f0-9]{64}$/.test(command.sha256 ?? ""))) return sendJson(response, 400, { error: "invalid_update_request" });
  if (command.job_id !== updateJob.job_id || (activation ? uploadActive || updateJob.phase !== "staged" ||
      command.sha256 !== updateJob.sha256 : !cancelUpdate())) return sendJson(response, 409, { error: "update_not_ready" });
  if (activation) {
    updateJob.phase = "activating";
    setTimeout(() => {
      if (process.env.PREVIEW_UPDATE_FAIL !== "boot") firmwareVersion = updateJob.candidate_version;
      sessions.clear();
      updateOwner = null;
      updateJob = { job_id: 0, phase: "idle", received: 0, expected: 0, candidate_version: "", sha256: "", error: "" };
    }, updateDelay).unref();
  }
  return sendJson(response, 202, { ...firmwareInfo(), ...updateJob });
}

function ssidDisplay(hex) {
  const bytes = Buffer.from(hex, "hex");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let display = "";
  for (let offset = 0; offset < bytes.length;) {
    let decoded = "";
    let width = 1;
    if (bytes[offset] >= 0x20 && bytes[offset] !== 0x7f) {
      for (; width <= 4 && offset + width <= bytes.length; width++) {
        try { decoded = decoder.decode(bytes.subarray(offset, offset + width)); break; }
        catch {}
      }
    }
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(decoded)) decoded = "";
    display += decoded || `\\x${bytes[offset].toString(16).padStart(2, "0").toUpperCase()}`;
    offset += decoded ? width : 1;
  }
  return display;
}

function finishNetwork(job, error = "") {
  network.job = job;
  network.error = error;
  network.busy = ["scanning", "testing", "handing_over", "awaiting_confirmation", "awaiting_ap_reconnect", "changing_ap_address"].includes(job);
  if (["awaiting_confirmation", "awaiting_ap_reconnect"].includes(job)) confirmationUntil = performance.now() + confirmationTtl;
}

async function networkRequest(request, response) {
  if (!authorized(request, response, request.method !== "GET")) return;
  if (request.method === "GET") return sendJson(response, 200, network);
  if (updateBusy()) return sendJson(response, 409, { error: "update_busy" });
  if (controller?.readyState === WebSocket.OPEN || pendingControl) return sendJson(response, 409, { error: "release_control_first" });
  const scan = request.url === "/api/v1/network/scan";
  if (scan) {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (chunk.length !== 0) {
        drainRequest(request);
        return sendJson(response, 413, { error: "invalid_network_request" });
      }
    }
  }
  const value = scan ? { action: "scan" } : await jsonBody(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) return sendJson(response, 400, { error: "invalid_network_request" });
  const fields = value.action === "connect" ? ["action", "ssid", "ssid_hex", "password"] : value.action === "rename" ? ["action", "hostname"] : ["action"];
  const hasTextSsid = Object.hasOwn(value, "ssid");
  const hasEncodedSsid = Object.hasOwn(value, "ssid_hex");
  const textSsid = typeof value.ssid === "string" && !value.ssid.includes("\0") && Buffer.byteLength(value.ssid) >= 1 && Buffer.byteLength(value.ssid) <= 32;
  const encodedSsid = typeof value.ssid_hex === "string" && /^(?:[0-9a-fA-F]{2}){1,32}$/.test(value.ssid_hex) && !Buffer.from(value.ssid_hex, "hex").includes(0);
  const expectedFields = value.action === "connect" ? 3 : fields.length;
  if (!Object.keys(value).every(key => fields.includes(key)) || Object.keys(value).length !== expectedFields ||
      !["scan", "connect", "ap", "station", "forget", "rename", "cancel", "confirm"].includes(value.action) ||
      (!scan && value.action === "scan") ||
      (value.action === "connect" && (hasTextSsid === hasEncodedSsid || !(hasTextSsid ? textSsid : encodedSsid) ||
        typeof value.password !== "string" || !/^[\x20-\x7e]{8,63}$/.test(value.password))) ||
      (value.action === "rename" && (typeof value.hostname !== "string" || value.hostname.length > 32 || value.hostname === "localhost" ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.hostname)))) return sendJson(response, 400, { error: "invalid_network_request" });
  if (controller?.readyState === WebSocket.OPEN || pendingControl) return sendJson(response, 409, { error: "release_control_first" });
  const writesConfiguration = !scan && value.action !== "confirm" && (value.action !== "cancel" ||
    (network.station_online && network.ap_active && network.job !== "scanning"));
  if (storageFault && writesConfiguration) return sendJson(response, 503, { error: "storage_failed" });
  if (network.busy && !["cancel", "confirm"].includes(value.action)) return sendJson(response, 409, { error: "network_busy" });
  if (value.action === "cancel" && !network.busy) return sendJson(response, 409, { error: "network_busy" });
  if (value.action === "confirm" && !["awaiting_confirmation", "awaiting_ap_reconnect"].includes(network.job)) return sendJson(response, 409, { error: "network_busy" });
  const confirmReconnect = value.action === "confirm" && network.job === "awaiting_ap_reconnect";
  const cancelScan = value.action === "cancel" && network.job === "scanning";
  const id = ++network.job_id;
  sendJson(response, 202, { job_id: id, management_url: `http://${request.headers.host}/` });
  const action = value.action;
  if (action === "cancel") {
    if (cancelScan) { finishNetwork("cancelled"); return; }
    if (network.station_online) network.desired_station = false;
    pendingProfile = null;
    Object.assign(network, { ap_active: true, ap_ip: network.ap_ip || "192.168.4.1", ap_reconnect_ip: "", station_online: false, station_ip: "", station_ssid: "", phase: "ap" });
    finishNetwork("cancelled");
    return;
  }
  if (action === "scan") network.scan = [];
  finishNetwork(action === "scan" ? "scanning" : confirmReconnect ? "changing_ap_address" : action === "confirm" ? "handing_over" : "testing");
  if (action === "connect" || action === "station") {
    Object.assign(network, { phase: "testing", ap_active: true, ap_ip: "192.168.4.1", station_online: false, station_ip: "" });
  }
  setTimeout(() => {
    if (network.job_id !== id) return;
    if (action === "scan") {
      const item = (ssid, rssi, supported) => {
        const ssidHex = Buffer.from(ssid).toString("hex");
        return { ssid: ssidDisplay(ssidHex), ssid_hex: ssidHex, rssi, supported };
      };
      network.scan = [item("Home Wi-Fi", -42, true),
        { ssid: "Cafe\\xFF", ssid_hex: "43616665ff", rssi: -70, supported: true },
        item("<Office & Guests>", -61, true),
        item("A-very-long-network-name-1234567", -65, true),
        item("Open\u202e network", -72, false)];
      const results = network.scan;
      setTimeout(() => { if (network.scan === results) network.scan = []; }, scanTtl).unref();
      finishNetwork("succeeded");
    } else if (action === "connect" || action === "station") {
      const ssidHex = action === "connect" ? value.ssid_hex ?? Buffer.from(value.ssid).toString("hex") : network.saved_ssid_hex;
      const ssid = ssidDisplay(ssidHex);
      const failure = !ssid ? "no_saved_network" : value.password === "wrong-password" ? "authentication_failed" :
        ssid === "offline-network" ? "network_not_found" : ssid === "no-dhcp-network" ? "dhcp_timeout" : "";
      if (failure) {
        network.phase = "ap";
        finishNetwork("failed", failure);
      } else if (ssid === "overlap-network") {
        pendingProfile = { ssid, ssidHex };
        network.ap_reconnect_ip = "172.30.4.1";
        finishNetwork("awaiting_ap_reconnect");
      } else {
        Object.assign(network, { desired_station: true, has_profile: true, saved_ssid: ssid, saved_ssid_hex: ssidHex, station_ssid: ssid,
          station_online: true, station_ip: "192.168.1.88", phase: "awaiting_confirmation" });
        finishNetwork("awaiting_confirmation");
      }
    } else if (confirmReconnect) {
      Object.assign(network, { ap_ip: network.ap_reconnect_ip, ap_reconnect_ip: "", desired_station: true, has_profile: true,
        saved_ssid: pendingProfile.ssid, saved_ssid_hex: pendingProfile.ssidHex, station_ssid: pendingProfile.ssid,
        station_online: true, station_ip: "192.168.4.88", phase: "awaiting_confirmation" });
      pendingProfile = null;
      finishNetwork("awaiting_confirmation");
    } else if (action === "confirm") {
      Object.assign(network, { phase: "station", ap_active: false, ap_ip: "" });
      finishNetwork("succeeded");
    } else if (action === "rename") {
      network.hostname = value.hostname;
      network.requested_hostname = value.hostname;
      finishNetwork("succeeded");
    } else {
      Object.assign(network, { phase: "ap", desired_station: false, ap_active: true, ap_ip: "192.168.4.1",
        station_online: false, station_ip: "", station_ssid: "" });
      if (action === "forget") Object.assign(network, { saved_ssid: "", saved_ssid_hex: "", has_profile: false });
      finishNetwork("succeeded");
    }
  }, networkDelay).unref();
}

function drainRequest(request) {
  drainingRequests.add(request);
  request.resume();
}

function sendJson(response, status, value) {
  if (status >= 400 && !response.req.readableEnded && !drainingRequests.has(response.req)) {
    response.setHeader("Connection", "close");
    response.once("finish", () => response.req.destroy());
  }
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

function sessionFor(request) {
  const cookie = request.headers.cookie ?? "";
  if (cookie.length > 512) return null;
  const matches = cookie.split(";").map(value => value.trim()).filter(value => value.startsWith("kb_session="));
  if (matches.length !== 1 || !/^kb_session=[a-f0-9]{64}$/.test(matches[0])) return null;
  const token = matches[0].slice(11);
  const session = sessions.get(token);
  if (!session) return null;
  const now = performance.now();
  if (now - session.lastSeen >= 900000 || now - session.createdAt >= 28800000) {
    sessions.delete(token);
    return null;
  }
  session.lastSeen = now;
  return session;
}

function requestAllowed(request, mutation = false) {
  const host = `127.0.0.1:${server.address().port}`;
  return request.headers.host === host && (!mutation || request.headers.origin === `http://${host}`);
}

function authorized(request, response, mutation = false) {
  if (!requestAllowed(request, mutation)) {
    sendJson(response, 403, { error: "origin_denied" });
    return null;
  }
  const session = sessionFor(request);
  if (!session) {
    sendJson(response, 401, { error: "login_required" });
    return null;
  }
  if (mutation && request.headers["x-csrf-token"] !== session.csrf) {
    sendJson(response, 403, { error: "csrf_denied" });
    return null;
  }
  if (mutation && network.ap_active) managementUntil = performance.now() + confirmationTtl;
  return session;
}

function sessionStatus(session) {
  return { provisioned: true, claimed, authenticated: Boolean(session), csrf: session?.csrf ?? "" };
}

function issueSession(response) {
  const now = performance.now();
  for (const [token, session] of sessions) {
    if (now - session.lastSeen >= 900000 || now - session.createdAt >= 28800000) sessions.delete(token);
  }
  if (sessions.size >= 4) return sendJson(response, 503, { error: "session_capacity" });
  const token = randomBytes(32).toString("hex");
  const session = { token, csrf: randomBytes(32).toString("hex"), createdAt: now, lastSeen: now };
  sessions.set(token, session);
  response.setHeader("Set-Cookie", `kb_session=${token}; Path=/; HttpOnly; SameSite=Strict`);
  sendJson(response, 200, sessionStatus(session));
}

function releaseController() {
  pendingControl = null;
  if (controller?.readyState === WebSocket.OPEN) {
    receipts.stop++;
    controller.pressed = false;
    controller.report = { modifiers: 0, keys: [] };
    controller.close(1000);
  }
}

async function jsonBody(request, { numbers = false, maximum = 1024 } = {}) {
  if (!/^application\/json(?:; charset=utf-8)?$/.test(request.headers["content-type"] ?? "")) {
    drainRequest(request);
    return null;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maximum) {
      drainRequest(request);
      return null;
    }
    chunks.push(chunk);
  }
  let tree;
  const errors = [];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  } catch { return null; }
  if (tree?.type !== "object" || errors.length) return null;
  const value = Object.create(null);
  for (const property of tree.children ?? []) {
    const [key, field] = property.children;
    if (numbers && field.type === "number" && Number.isFinite(field.value) && !Object.hasOwn(value, key.value)) {
      value[key.value] = field.value;
      continue;
    }
    if (field.type !== "string" || !key.value.isWellFormed() || !field.value.isWellFormed() ||
        key.value.includes("\0") || field.value.includes("\0") || Object.hasOwn(value, key.value)) return null;
    value[key.value] = field.value;
  }
  return value;
}

async function credentialsBody(request, claim) {
  const value = await jsonBody(request);
  const fields = claim ? ["password", "setup_code"] : ["password"];
  if (!value || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !Object.keys(value).every(key => fields.includes(key)) || typeof value.password !== "string" ||
      Buffer.byteLength(value.password) < 12 || Buffer.byteLength(value.password) > 128 ||
      (claim && !/^[a-f0-9]{24}$/.test(value.setup_code ?? ""))) return null;
  return value;
}

function inputSnapshot() {
  return {
    ...receipts,
    connected: controller?.readyState === WebSocket.OPEN,
    pressed: controller?.pressed ?? false,
    report: controller?.report ?? { modifiers: 0, keys: [] },
    caps_lock: capsLock,
  };
}

function usbStatus() {
  return { v: 1, type: "status", usb_ready: usbReady, caps_lock: capsLock };
}

function validReport(message) {
  const validEnvelope = Number.isInteger(message.seq) && message.seq > 0 && message.seq <= 2147483647 &&
    Number.isInteger(message.modifiers) && message.modifiers >= 0 && message.modifiers <= 255 &&
    Array.isArray(message.keys) && message.keys.length <= 6 &&
    new Set(message.keys).size === message.keys.length &&
    message.keys.every(Number.isInteger);
  if (!validEnvelope) return false;
  const globe = (message.modifiers === 1 || message.modifiers === 8) &&
    message.keys.length === 1 && message.keys[0] === 44;
  const cancel = message.modifiers === 0 && message.keys.length === 1 && message.keys[0] === 41;
  const typing = (message.modifiers & ~0x22) === 0 && message.keys.every(usage =>
    (usage >= 4 && usage <= 40) || usage === 42 ||
    (usage >= 44 && usage <= 57 && usage !== 50));
  return globe || cancel || typing;
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/keyboard.mjs", ["keyboard.mjs", "text/javascript; charset=utf-8"]],
  ...["shift", "caps", "backspace", "return", "release", "settings", "logout", "eye", "eye-off", "back", "refresh", "globe", "x"].map(icon =>
    [`/icons/${icon}.svg`, [`icons/${icon}.svg`, "image/svg+xml"]]),
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (!requestAllowed(request, request.method !== "GET")) {
    sendJson(response, 403, { error: "origin_denied" });
    return;
  }
  if (request.url === "/api/v1/session" && request.method === "GET") {
    sendJson(response, 200, sessionStatus(sessionFor(request)));
    return;
  }
  if (request.url === "/api/v1/session" && request.method === "DELETE") {
    const session = authorized(request, response, true);
    if (!session) return;
    if (controller?.session === session || pendingControl?.session === session) releaseController();
    if (updateOwner === session) cancelUpdate();
    sessions.delete(session.token);
    response.setHeader("Set-Cookie", "kb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    sendJson(response, 200, sessionStatus(null));
    return;
  }
  if (["/api/v1/session", "/api/v1/claim"].includes(request.url) && request.method === "POST") {
    const claim = request.url === "/api/v1/claim";
    if (claim === claimed) return sendJson(response, 409, { error: claimed ? "already_claimed" : "claim_required" });
    const now = performance.now();
    if (now - loginWindow >= 60000) { loginWindow = now; loginAttempts = 0; }
    if (++loginAttempts > 5) return sendJson(response, 429, { error: "login_rate_limited" });
    const value = await credentialsBody(request, claim).catch(() => null);
    if (!value) return sendJson(response, 400, { error: "invalid_credentials" });
    if (claim) {
      if (claimed) return sendJson(response, 409, { error: "already_claimed" });
      if (value.setup_code !== setupCode) return sendJson(response, 401, { error: "invalid_setup_code" });
      ownerHash = passwordHash(value.password);
      claimed = true;
    } else if (!timingSafeEqual(passwordHash(value.password), ownerHash)) return sendJson(response, 401, { error: "invalid_credentials" });
    issueSession(response);
    return;
  }
  if (["/api/v1/control/take", "/api/v1/control/stop"].includes(request.url) && request.method === "POST") {
    const session = authorized(request, response, true);
    if (!session) return;
    if (request.url.endsWith("/stop")) releaseController();
    else {
      if (updateBusy()) return sendJson(response, 409, { error: "update_busy" });
      if (controller?.readyState === WebSocket.OPEN || pendingControl) return sendJson(response, 409, { error: "busy" });
      if (!usbReady) return sendJson(response, 503, { error: "usb_unavailable" });
      if (!network.can_control || network.busy) return sendJson(response, 409, { error: "network_busy" });
      pendingControl = { session, until: performance.now() + 5000 };
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  if ((request.url === "/api/v1/network/job" && request.method === "GET") ||
      (["/api/v1/network", "/api/v1/network/scan"].includes(request.url) && request.method === "POST")) {
    await networkRequest(request, response).catch(() => { if (!response.headersSent) sendJson(response, 400, { error: "invalid_network_request" }); });
    return;
  }
  if (["/api/v1/firmware", "/api/v1/update", "/api/v1/update/job", "/api/v1/update/activate"].includes(request.url)) {
    await updateRequest(request, response).catch(() => { if (!response.headersSent) sendJson(response, 400, { error: "invalid_update_request" }); });
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  if (request.url === "/api/v1/status") {
    if (!authorized(request, response)) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ...usbStatus(), network }));
    return;
  }
  if (request.url === "/__test__/input") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(inputSnapshot()));
    return;
  }
  const asset = assets.get(request.url);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const contents = await readFile(new URL(`../components/web_server/www/${asset[0]}`, import.meta.url));
    response.setHeader("Content-Type", asset[1]);
    response.end(contents);
  } catch {
    response.writeHead(500).end();
  }
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/api/v1/keyboard") {
    socket.destroy();
    return;
  }
  const session = requestAllowed(request, true) ? sessionFor(request) : null;
  if (!session) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (pendingControl?.session !== session || performance.now() >= pendingControl.until || !usbReady || !network.available || network.busy) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  if (controller !== null && controller.readyState === WebSocket.OPEN) {
    if (performance.now() - controller.lastSeen < 1000) {
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
      return;
    }
    controller.terminate();
  }
  pendingControl = null;
  websocketServer.handleUpgrade(request, socket, head, (connection) => {
    controller = connection;
    connection.pressed = false;
    connection.report = { modifiers: 0, keys: [] };
    connection.sequence = 0;
    connection.lastSeen = performance.now();
    connection.session = session;
    connection.on("error", () => connection.terminate());
    connection.on("close", () => {
      if (connection.pressed) receipts.forced_release++;
      connection.pressed = false;
      connection.report = { modifiers: 0, keys: [] };
      if (controller === connection) controller = null;
    });
    connection.on("message", (data, binary) => {
        if (connection !== controller || binary || performance.now() - connection.lastSeen >= 1000 ||
          !sessions.has(session.token) || performance.now() - session.createdAt >= 28800000) {
        connection.close(1008);
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        connection.close(1008);
        return;
      }
      const fields = message?.type === "state" ? ["v", "type", "seq", "modifiers", "keys"] : ["v", "type"];
      if (message?.v !== 1 || Object.keys(message).length !== fields.length ||
          !Object.keys(message).every(field => fields.includes(field))) {
        connection.close(1008);
        return;
      }
      connection.lastSeen = performance.now();
      session.lastSeen = connection.lastSeen;
      if (message.type === "ping") connection.send(JSON.stringify(usbStatus()));
      else if (message.type === "state" && usbReady && validReport(message) && message.seq === connection.sequence + 1) {
        receipts.down += message.keys.filter(usage => !connection.report.keys.includes(usage)).length;
        receipts.up += connection.report.keys.filter(usage => !message.keys.includes(usage)).length;
        if (message.keys.includes(57) && !connection.report.keys.includes(57) && capsLock !== null) capsLock = !capsLock;
        connection.report = { modifiers: message.modifiers, keys: [...message.keys].sort((left, right) => left - right) };
        connection.sequence = message.seq;
        connection.pressed = message.keys.length > 0 || message.modifiers !== 0;
        connection.send(JSON.stringify({ v: 1, type: "queued", seq: message.seq }), (error) => {
          if (!error) receipts.queued++;
        });
      }
      else if (message.type === "stop") {
        receipts.stop++;
        connection.pressed = false;
        connection.report = { modifiers: 0, keys: [] };
        connection.close(1000);
      }
      else connection.close(1008);
    });
  });
});

setInterval(() => {
  if (updateBusy() && updateJob.phase !== "activating") {
    if (!sessions.has(updateOwner?.token)) cancelUpdate();
    else if (performance.now() >= updateDeadline || (updateJob.phase === "receiving" && performance.now() - updateLastProgress >= 10000)) {
      Object.assign(updateJob, { phase: "failed", error: "update_timeout" });
    }
  }
  if (pendingControl && (performance.now() >= pendingControl.until || !sessions.has(pendingControl.session.token))) pendingControl = null;
  if (controller !== null && performance.now() - controller.lastSeen >= 1000) controller.terminate();
  if (!updateBusy() && performance.now() >= confirmationUntil && performance.now() >= managementUntil) {
    if (network.job === "awaiting_confirmation") {
      Object.assign(network, { ap_active: false, ap_ip: "", phase: "station" });
      finishNetwork("succeeded");
    } else if (network.job === "awaiting_ap_reconnect") {
      pendingProfile = null;
      Object.assign(network, { ap_reconnect_ip: "", phase: "ap" });
      finishNetwork("failed", "confirmation_timeout");
    }
  }
}, 250).unref();

const port = Number(process.env.PORT || 8080);
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`UI preview: ${url}/ (USB mocked, no keystrokes leave this server)`);
  console.log(`Receipt counters: ${url}/__test__/input`);
  process.send?.({ type: "listening", url });
});

function shutdown() {
  console.log("Preview receipts:", JSON.stringify(inputSnapshot()));
  for (const connection of websocketServer.clients) connection.terminate();
  websocketServer.close();
  server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);