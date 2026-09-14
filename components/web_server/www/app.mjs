import { KeyboardInput, layouts, bottomRow, physicalKeys } from "./keyboard.mjs";

const surface = document.querySelector("#keyboard");
const rows = document.querySelector("#key-rows");
const connectionStatus = document.querySelector("#connection-status");
const usbStatus = document.querySelector("#usb-status");
const capsStatus = document.querySelector("#caps-status");
const keyState = document.querySelector("#key-state");
const keyboard = new KeyboardInput();
const definitions = new Map();
const pending = new Map();
let page = "letters";
let socket = null;
let ready = false;
let sequence = 0;
let lastReport = JSON.stringify(keyboard.report);
let lastReply = 0;
let connectedAt = 0;
let reconnectTimer = null;

function drawLayout() {
  definitions.clear();
  rows.replaceChildren();
  rows.dataset.page = page;
  const layout = [...layouts[page], bottomRow(page)];
  layout.forEach((keys, rowIndex) => {
    const row = document.createElement("div");
    row.className = "key-row";
    if (rowIndex === 1 && page === "letters") row.classList.add("home");
    if (rowIndex === 2) row.classList.add(page === "letters" ? "lower" : "punctuation");
    if (rowIndex === 3) row.classList.add("bottom");
    keys.forEach((key, keyIndex) => {
      const button = document.createElement("button");
      const id = `${rowIndex}:${keyIndex}`;
      definitions.set(id, key);
      button.type = "button";
      button.className = `key${key.action || key.icon ? " special" : ""}`;
      button.dataset.key = id;
      if (key.code) button.dataset.code = key.code;
      if (key.action) button.dataset.action = key.action;
      if (key.page) button.dataset.page = key.page;
      if (key.code === "KeyA") button.id = "a-key";
      const label = key.code === "Backspace" ? "Backspace" : key.code === "Enter" ? "Return" :
        key.code === "Space" ? "Space" : key.code?.startsWith("Key") ? key.code.slice(3) : key.label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", "false");
      if (key.icon) {
        const icon = document.createElement("span");
        icon.className = "icon";
        icon.dataset.icon = key.icon;
        icon.setAttribute("aria-hidden", "true");
        button.append(icon);
        button.title = label;
      } else {
        const labelElement = document.createElement("span");
        labelElement.className = "key-label";
        labelElement.textContent = key.label;
        button.append(labelElement);
      }
      row.append(button);
    });
    rows.append(row);
  });
  render();
}

function render() {
  const report = keyboard.report;
  for (const button of rows.querySelectorAll("button")) {
    const key = definitions.get(button.dataset.key);
    button.disabled = key.action !== "page" && !ready;
    if (key.action === "shift") {
      button.dataset.shift = keyboard.capsPending ? "pending" : keyboard.capsLock === true ? "caps" :
        keyboard.shiftLatched ? "latched" : "off";
      button.dataset.held = String((report.modifiers & 0x22) !== 0);
      button.setAttribute("aria-pressed", String(keyboard.shiftActive || keyboard.capsLock === true));
      button.querySelector(".icon").dataset.icon = keyboard.capsLock === true ? "caps" : "shift";
    } else {
      button.setAttribute("aria-pressed", String(key.usage !== undefined && report.keys.includes(key.usage)));
    }
    if (key.code?.startsWith("Key")) {
      button.querySelector(".key-label").textContent = keyboard.uppercase ? key.upper : key.label;
    }
  }
  capsStatus.textContent = keyboard.capsPending ? "Caps pending" : keyboard.capsLock === null ? "Caps unknown" :
    keyboard.capsLock ? "Caps on" : "Caps off";
  capsStatus.dataset.state = keyboard.capsPending ? "pending" : keyboard.capsLock ? "on" : "off";
  keyState.textContent = report.keys.length || report.modifiers ? "Pressed" : "Released";
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 500);
}

function disconnect() {
  const previous = socket;
  socket = null;
  ready = false;
  keyboard.clear();
  keyboard.setCapsLock(null);
  pending.clear();
  sequence = 0;
  lastReport = JSON.stringify(keyboard.report);
  connectionStatus.textContent = "Disconnected";
  connectionStatus.dataset.ready = "false";
  usbStatus.textContent = "USB unknown";
  usbStatus.dataset.ready = "false";
  if (previous !== null) {
    try {
      if (previous.readyState === WebSocket.OPEN) previous.send(JSON.stringify({ v: 1, type: "stop" }));
    } catch {}
    try { previous.close(); } catch {}
  }
  render();
  scheduleReconnect();
}

function transmit(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024) {
    disconnect();
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    disconnect();
    return false;
  }
}

function publish(reports) {
  for (const report of reports) {
    const serialized = JSON.stringify(report);
    if (serialized === lastReport) continue;
    if (!ready || pending.size >= 16 || sequence >= 2147483647) {
      disconnect();
      return;
    }
    const next = ++sequence;
    if (!transmit({ v: 1, type: "state", seq: next, ...report })) return;
    pending.set(next, performance.now());
    lastReport = serialized;
  }
  render();
}

function changeInput(operation) {
  try {
    publish(operation());
  } catch {
    disconnect();
  }
}

function switchPage(nextPage) {
  keyboard.clear();
  if (ready) publish([keyboard.report]);
  page = nextPage;
  drawLayout();
  surface.focus({ preventScroll: true });
}

function connect() {
  if (socket !== null || document.hidden || !document.hasFocus()) return;
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const endpoint = new URL("/api/v1/keyboard", location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(endpoint);
  socket = connection;
  connectedAt = performance.now();
  connectionStatus.textContent = "Connecting";
  connectionStatus.dataset.ready = "false";
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    lastReply = performance.now();
    connectionStatus.textContent = "Connected";
    connectionStatus.dataset.ready = "true";
    transmit({ v: 1, type: "ping" });
  });
  connection.addEventListener("message", event => {
    if (socket !== connection) return;
    if (document.hidden || !document.hasFocus()) { disconnect(); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { disconnect(); return; }
    if (!message || message.v !== 1) { disconnect(); return; }
    if (message.type === "queued" && pending.size && message.seq === pending.keys().next().value) {
      pending.delete(message.seq);
    } else if (message.type === "status" && typeof message.usb_ready === "boolean" &&
               (message.caps_lock === null || typeof message.caps_lock === "boolean")) {
      if (!message.usb_ready && ready) { disconnect(); return; }
      ready = message.usb_ready;
      keyboard.setCapsLock(ready ? message.caps_lock : null);
      usbStatus.textContent = ready ? "USB ready" : "USB waiting";
      usbStatus.dataset.ready = String(ready);
      render();
      if (ready && document.activeElement === document.body) surface.focus({ preventScroll: true });
    } else { disconnect(); return; }
    lastReply = performance.now();
  });
  for (const event of ["close", "error"]) connection.addEventListener(event, () => {
    if (socket === connection) disconnect();
  });
}

surface.addEventListener("pointerdown", event => {
  const button = event.target.closest("button[data-key]");
  if (!button || button.disabled || event.button !== 0) return;
  event.preventDefault();
  surface.focus({ preventScroll: true });
  const key = definitions.get(button.dataset.key);
  if (key.action === "page") { switchPage(key.page); return; }
  try { surface.setPointerCapture(event.pointerId); } catch { disconnect(); return; }
  changeInput(() => keyboard.press(`pointer:${event.pointerId}`, key, performance.now()));
});

surface.addEventListener("pointerup", event => {
  const source = `pointer:${event.pointerId}`;
  if (!keyboard.sources.has(source)) return;
  event.preventDefault();
  changeInput(() => keyboard.release(source, performance.now()));
  if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
});

surface.addEventListener("lostpointercapture", event => {
  if (keyboard.sources.has(`pointer:${event.pointerId}`)) disconnect();
});
surface.addEventListener("pointercancel", disconnect);
surface.addEventListener("contextmenu", event => event.preventDefault());
surface.addEventListener("click", event => {
  event.preventDefault();
  const button = event.target.closest("button[data-key]");
  if (!button || button.disabled || event.detail !== 0) return;
  const key = definitions.get(button.dataset.key);
  surface.focus({ preventScroll: true });
  if (key.action === "page") { switchPage(key.page); return; }
  changeInput(() => keyboard.press("accessible", key, performance.now()));
  changeInput(() => keyboard.release("accessible", performance.now()));
});

surface.addEventListener("keydown", event => {
  if (!ready || event.isComposing || event.target.closest("input, textarea, select, [contenteditable]")) return;
  if (event.ctrlKey || event.altKey || event.metaKey) {
    if (keyboard.sources.size) disconnect();
    return;
  }
  const key = physicalKeys.get(event.code);
  if (!key) return;
  event.preventDefault();
  if (!event.repeat) changeInput(() => keyboard.press(`physical:${event.code}`, key, performance.now()));
});
window.addEventListener("keyup", event => {
  const source = `physical:${event.code}`;
  if (!keyboard.sources.has(source)) return;
  event.preventDefault();
  changeInput(() => keyboard.release(source, performance.now()));
});

surface.addEventListener("focusout", event => { if (!surface.contains(event.relatedTarget)) disconnect(); });
document.querySelector("#release").addEventListener("click", disconnect);
for (const event of ["blur", "pagehide"]) window.addEventListener(event, disconnect);
window.addEventListener("focus", connect);
document.addEventListener("visibilitychange", () => { if (document.hidden) disconnect(); else connect(); });

setInterval(() => {
  if (!socket) return;
  const now = performance.now();
  if (document.hidden || !document.hasFocus() ||
      (socket.readyState === WebSocket.CONNECTING && now - connectedAt >= 3000) ||
      (socket.readyState === WebSocket.OPEN && now - lastReply >= 1000) ||
      (pending.size && now - pending.values().next().value >= 250)) {
    disconnect();
    return;
  }
  keyboard.expireCapsRequest(now);
  render();
  if (socket.readyState === WebSocket.OPEN) transmit({ v: 1, type: "ping" });
}, 250);

drawLayout();
connect();