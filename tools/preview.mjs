import { createServer } from "node:http";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";

const usbReady = process.env.PREVIEW_USB_READY !== "0";
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 256 });
let capsLock = process.env.PREVIEW_CAPS_LOCK === "unknown" ? null : process.env.PREVIEW_CAPS_LOCK === "1";
let controller = null;
const receipts = { down: 0, up: 0, stop: 0, queued: 0, forced_release: 0 };
let claimed = process.env.PREVIEW_CLAIMED !== "0";
const ownerSalt = randomBytes(16);
const passwordHash = password => pbkdf2Sync(password, ownerSalt, 100000, 32, "sha256");
let ownerHash = passwordHash(process.env.PREVIEW_OWNER_PASSWORD ?? "preview-owner-password");
const setupCode = "0123456789abcdef01234567";
const sessions = new Map();
let pendingControl = null;
let loginWindow = 0;
let loginAttempts = 0;
const network = { available: true, ap_active: true, station_online: false, desired_station: false,
  has_profile: false, busy: false, mdns: true, can_control: true, job_id: 0, phase: "ap", job: "idle", error: "",
  hostname: "kb", requested_hostname: "kb", ap_ssid: "WiFiKeyboard-123456", saved_ssid: "", station_ssid: "",
  ap_ip: "192.168.4.1", station_ip: "", scan: [] };
const networkDelay = Math.max(50, Number(process.env.PREVIEW_NETWORK_DELAY_MS) || 200);

function finishNetwork(job, error = "") {
  network.job = job;
  network.error = error;
  network.busy = ["scanning", "testing", "handing_over", "awaiting_confirmation"].includes(job);
  network.can_control = !network.busy;
}

async function networkRequest(request, response) {
  if (!authorized(request, response, request.method !== "GET")) return;
  if (request.method === "GET") return sendJson(response, 200, network);
  if (controller?.readyState === WebSocket.OPEN || pendingControl) return sendJson(response, 409, { error: "release_control_first" });
  const scan = request.url === "/api/v1/network/scan";
  const value = scan ? { action: "scan" } : await jsonBody(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) return sendJson(response, 400, { error: "invalid_network_request" });
  const fields = value.action === "connect" ? ["action", "ssid", "password"] : value.action === "rename" ? ["action", "hostname"] : ["action"];
  if (!Object.keys(value).every(key => fields.includes(key)) || Object.keys(value).length !== fields.length ||
      !["scan", "connect", "ap", "station", "forget", "rename", "cancel", "confirm"].includes(value.action) ||
      (!scan && value.action === "scan") ||
      (value.action === "connect" && (typeof value.ssid !== "string" || Buffer.byteLength(value.ssid) < 1 || Buffer.byteLength(value.ssid) > 32 ||
        typeof value.password !== "string" || !/^[\x20-\x7e]{8,63}$/.test(value.password))) ||
      (value.action === "rename" && (typeof value.hostname !== "string" || value.hostname.length > 32 || value.hostname === "localhost" ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value.hostname)))) return sendJson(response, 400, { error: "invalid_network_request" });
  if (network.busy && !["cancel", "confirm"].includes(value.action)) return sendJson(response, 409, { error: "network_busy" });
  if (value.action === "confirm" && network.job !== "awaiting_confirmation") return sendJson(response, 409, { error: "network_busy" });
  const id = ++network.job_id;
  sendJson(response, 202, { job_id: id });
  const action = value.action;
  if (action === "cancel") {
    if (network.station_online) network.desired_station = false;
    Object.assign(network, { ap_active: true, ap_ip: "192.168.4.1", station_online: false, station_ip: "", station_ssid: "", phase: "ap" });
    finishNetwork("cancelled");
    return;
  }
  finishNetwork(action === "scan" ? "scanning" : action === "confirm" ? "handing_over" : "testing");
  if (action === "connect" || action === "station") {
    Object.assign(network, { phase: "testing", ap_active: true, ap_ip: "192.168.4.1", station_online: false, station_ip: "" });
  }
  setTimeout(() => {
    if (network.job_id !== id) return;
    if (action === "scan") {
      network.scan = [{ ssid: "Home Wi-Fi", rssi: -42, supported: true },
        { ssid: "Hidden / manual entry", rssi: -70, supported: false },
        { ssid: "<Office & Guests>", rssi: -61, supported: true },
        { ssid: "A-very-long-network-name-123456789", rssi: -65, supported: true },
        { ssid: "Open network", rssi: -72, supported: false }];
      finishNetwork("succeeded");
    } else if (action === "connect" || action === "station") {
      const ssid = action === "connect" ? value.ssid : network.saved_ssid;
      const failure = !ssid ? "no_saved_network" : value.password === "wrong-password" ? "authentication_failed" :
        ssid === "offline-network" ? "network_not_found" : ssid === "no-dhcp-network" ? "dhcp_timeout" : "";
      if (failure) {
        network.phase = "ap";
        finishNetwork("failed", failure);
      } else {
        Object.assign(network, { desired_station: true, has_profile: true, saved_ssid: ssid, station_ssid: ssid,
          station_online: true, station_ip: "192.168.1.88", phase: "awaiting_confirmation" });
        finishNetwork("awaiting_confirmation");
      }
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
      if (action === "forget") Object.assign(network, { saved_ssid: "", has_profile: false });
      finishNetwork("succeeded");
    }
  }, networkDelay).unref();
}

function sendJson(response, status, value) {
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

async function jsonBody(request) {
  if (!/^application\/json(?:; charset=utf-8)?$/.test(request.headers["content-type"] ?? "")) return null;
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 1024) return null;
  }
  if (text.includes("\\u0000") || text.includes("\0")) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
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
  return Number.isInteger(message.seq) && message.seq > 0 && message.seq <= 2147483647 &&
    Number.isInteger(message.modifiers) && message.modifiers >= 0 && message.modifiers <= 255 &&
    (message.modifiers & ~0x22) === 0 && Array.isArray(message.keys) && message.keys.length <= 6 &&
    new Set(message.keys).size === message.keys.length && message.keys.every(usage =>
      Number.isInteger(usage) && ((usage >= 4 && usage <= 40) || usage === 42 ||
        (usage >= 44 && usage <= 57 && usage !== 50)));
}

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/keyboard.mjs", ["keyboard.mjs", "text/javascript; charset=utf-8"]],
  ...["shift", "caps", "backspace", "return", "release", "settings", "logout", "eye", "eye-off", "back", "refresh"].map(icon =>
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
    sessions.delete(session.token);
    response.setHeader("Set-Cookie", "kb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    sendJson(response, 200, sessionStatus(null));
    return;
  }
  if (["/api/v1/session", "/api/v1/claim"].includes(request.url) && request.method === "POST") {
    const claim = request.url === "/api/v1/claim";
    if (claim === claimed) return sendJson(response, 409, { error: claimed ? "already_claimed" : "claim_required" });
    if (!claim && (controller?.readyState === WebSocket.OPEN || pendingControl)) return sendJson(response, 409, { error: "busy" });
    const now = performance.now();
    if (now - loginWindow >= 60000) { loginWindow = now; loginAttempts = 0; }
    if (++loginAttempts > 5) return sendJson(response, 429, { error: "login_rate_limited" });
    const value = await credentialsBody(request, claim).catch(() => null);
    if (!value) return sendJson(response, 400, { error: "invalid_credentials" });
    if (claim) {
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
  const session = sessionFor(request);
  if (!requestAllowed(request, true) || !session) {
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
  if (pendingControl?.session !== session || performance.now() >= pendingControl.until || !usbReady || !network.can_control) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
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
  if (pendingControl && (performance.now() >= pendingControl.until || !sessions.has(pendingControl.session.token))) pendingControl = null;
  if (controller !== null && performance.now() - controller.lastSeen >= 1000) controller.terminate();
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