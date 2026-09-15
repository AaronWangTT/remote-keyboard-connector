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
let account = { provisioned: false, claimed: true, authenticated: false, csrf: "" };
let controlAttempt = 0;
let takingControl = false;
let accountLoaded = false;
let currentView = "keyboard";
let networkState = null;
let networkTimer = null;
let networkPolling = false;
let networkMutating = false;
let networkUncertain = false;
let networkFieldsInitialized = false;
let networkFieldsJob = 0;
let renderedProfile = "";
let renderedScan = "";

function notify(message = "") {
  const output = document.querySelector("#ui-message");
  output.textContent = message;
  output.hidden = !message;
}

function errorMessage(error) {
  return ({ invalid_credentials: "Owner password not accepted. Use 12 to 128 bytes.",
    invalid_setup_code: "Owner setup code not accepted.", already_claimed: "This keyboard has already been claimed. Sign in with the owner password.",
    login_rate_limited: "Too many attempts. Try again in a minute.", busy: "Keyboard is in use. Release control and try again.",
    usb_unavailable: "USB is not ready.", csrf_denied: "Session changed. Reload and sign in again.",
    provisioning_required: "This keyboard needs sender provisioning.", claim_failed: "Owner setup could not be saved. Reconnect before trying again.",
    network_busy: "Network operation in progress. Refresh its status before trying again.",
    release_control_first: "Release keyboard control before changing the network.",
    storage_failed: "Settings storage is unavailable. Restart the keyboard before retrying.",
    invalid_network_request: "Check the network name, password, and hostname.",
    login_required: "Sign in to continue." })[error.code] ?? "Cannot reach the keyboard. Check the connection and try again.";
}

async function api(path, method = "GET", body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && account.csrf) headers["X-CSRF-Token"] = account.csrf;
  const response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.timeout(method === "POST" && ["/api/v1/session", "/api/v1/claim"].includes(path) ? 30000 : 5000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? "request_failed");
    error.code = result.error;
    error.status = response.status;
    if (response.status === 401 && !(method === "POST" && ["/api/v1/session", "/api/v1/claim"].includes(path))) {
      account.authenticated = false;
      account.csrf = "";
      disconnect();
    }
    throw error;
  }
  return result;
}

function setPasswordVisibility(button, revealed) {
  const input = document.getElementById(button.dataset.passwordToggle);
  input.type = revealed ? "text" : "password";
  button.querySelector(".icon").dataset.icon = revealed ? "eye-off" : "eye";
  button.title = `${revealed ? "Hide" : "Show"} ${input.id === "wifi-password" ? "Wi-Fi password" : "password"}`;
  button.setAttribute("aria-label", button.title);
}

function clearNetworkPassword() {
  document.querySelector("#wifi-password").value = "";
  setPasswordVisibility(document.querySelector('[data-password-toggle="wifi-password"]'), false);
}

function renderAccount() {
  if (!account.authenticated) {
    currentView = "keyboard";
    clearNetworkPassword();
    setPasswordVisibility(document.querySelector('[data-password-toggle="owner-password"]'), false);
  }
  document.querySelector("#account-view").hidden = account.authenticated;
  surface.hidden = !account.authenticated || currentView !== "keyboard";
  document.querySelector("#network-view").hidden = !account.authenticated || currentView !== "network";
  for (const id of ["take-control", "release", "network-settings"]) document.getElementById(id).hidden = !account.authenticated || currentView !== "keyboard";
  document.querySelector("#logout").hidden = !account.authenticated;
  document.querySelector("#take-control").disabled = !account.authenticated || socket !== null || takingControl;
  const claiming = !account.claimed;
  document.querySelector("#account-title").textContent = claiming ? "Claim keyboard" : "Sign in";
  document.querySelector("#account-submit").textContent = claiming ? "Claim keyboard" : "Sign in";
  document.querySelector("#account-submit").disabled = !accountLoaded || !account.provisioned;
  document.querySelector("#setup-code-field").hidden = !claiming;
  document.querySelector("#password-confirm-field").hidden = !claiming;
  document.querySelector("#setup-code").required = claiming;
  document.querySelector("#owner-password-confirm").required = claiming;
  document.querySelector("#owner-password").autocomplete = claiming ? "new-password" : "current-password";
}

async function loadSession() {
  try {
    const previous = account.authenticated;
    account = await api("/api/v1/session");
    accountLoaded = true;
    document.querySelector("#session-retry").hidden = true;
    if (previous && !account.authenticated) disconnect();
    if (socket === null) connectionStatus.textContent = account.authenticated ? "Released" : "Signed out";
    renderAccount();
    if (account.authenticated) pollNetwork();
    if (!account.provisioned) notify("This keyboard needs sender provisioning.");
  } catch (error) {
    notify(errorMessage(error));
    document.querySelector("#session-retry").hidden = false;
  }
}

function renderNetwork() {
  const state = networkState;
  const stationMode = document.querySelector('[name="network-mode"]:checked').value === "station";
  document.querySelector("#station-fields").hidden = !stationMode;
  document.querySelector("#wifi-ssid").required = stationMode;
  document.querySelector("#wifi-password").required = stationMode;
  document.querySelector("#network-apply").textContent = stationMode ? "Test and Connect" : "Use Standalone AP";
  const busy = !state || state.busy || !state.available || networkMutating || networkUncertain;
  for (const input of document.querySelectorAll("#network-form input, #network-form select, #network-form button, #hostname-form input, #hostname-form button")) input.disabled = busy;
  document.querySelector("#forget-network").hidden = !state?.has_profile;
  document.querySelector("#forget-network").disabled = busy;
  document.querySelector("#network-use-saved").hidden = !state?.has_profile;
  const reconnectingAp = state?.job === "awaiting_ap_reconnect";
  const confirming = state?.job === "awaiting_confirmation" || reconnectingAp;
  document.querySelector("#network-confirm").hidden = !confirming;
  document.querySelector("#network-confirm").disabled = networkMutating || networkUncertain;
  document.querySelector("#network-confirm").textContent = reconnectingAp ? "Change AP address" : "Switch to Wi-Fi";
  document.querySelector("#network-cancel").hidden = !state?.busy || state.job === "queued";
  document.querySelector("#network-cancel").disabled = networkMutating || networkUncertain;
  document.querySelector("#network-cancel").textContent = confirming ? "Keep AP mode" : "Cancel";
  document.querySelector("#network-retry").hidden = !networkUncertain;
  if (!state) return;
  const phase = ({ ap: "Standalone AP", station: "Connected to Wi-Fi", connecting: "Connecting to Wi-Fi",
    recovery: "Recovery AP", testing: "Testing network", awaiting_confirmation: "Wi-Fi connected; AP still active" })[state.phase] ?? state.phase;
  document.querySelector("#network-phase").textContent = phase;
  document.querySelector("#network-name").textContent = `${state.hostname}.local${state.mdns ? "" : " (mDNS unavailable)"}`;
  document.querySelector("#network-ap-address").textContent = state.ap_ip || "Off";
  if (state.ap_reconnect_ip) {
    const reconnect = document.createElement("a");
    reconnect.href = `http://${state.ap_reconnect_ip}/`;
    reconnect.textContent = state.ap_reconnect_ip;
    reconnect.target = "_blank";
    reconnect.rel = "noopener";
    document.querySelector("#network-ap-address").append(" -> ", reconnect);
  }
  document.querySelector("#network-station-address").textContent = state.station_ip || "Not connected";
  document.querySelector("#network-saved").textContent = state.saved_ssid || "None";
  document.querySelector("#network-summary").textContent = state.station_online ? "Wi-Fi connected" : state.phase === "recovery" ? "Recovery AP" : "Local AP";
  const errors = { authentication_failed: "Wi-Fi authentication failed.", network_not_found: "Network not found.",
    dhcp_timeout: "The router did not assign an IP address.", connection_timeout: "Connection timed out.",
    connection_failed: "Wi-Fi connection failed.", connection_lost: "Wi-Fi connection lost.",
    scan_failed: "Network scan failed.", scan_timeout: "Network scan timed out.", scan_unavailable: "Network scan is unavailable.",
    no_saved_network: "No saved Wi-Fi network.", storage_failed: "Settings could not be saved. Restart the keyboard before retrying.",
    configuration_failed: "Network settings could not be applied. Check the current network status before retrying.",
    unsupported_network: "This network's security mode is not supported.", subnet_overlap: "The AP and router address ranges overlap.",
    saved_configuration_invalid: "Saved settings are invalid. Recovery AP is available.", wifi_unavailable: "Wi-Fi is unavailable.",
    handover_failed: "Could not switch to Wi-Fi. Recovery AP is available.",
    confirmation_timeout: "Confirmation expired. The current AP address is unchanged." };
  const jobs = { idle: "Ready", queued: "Request accepted", testing: "Connecting and checking DHCP", scanning: "Scanning networks",
    succeeded: "Settings ready", failed: "Operation failed", cancelled: "Operation cancelled", handing_over: "Switching to Wi-Fi",
    awaiting_ap_reconnect: "AP address change requires confirmation", changing_ap_address: "Changing AP address",
    awaiting_confirmation: "Wi-Fi connected. Waiting for handover confirmation." };
  document.querySelector("#network-job-status").textContent = networkUncertain ? "Connection changed. Checking the last operation; credentials will not be resubmitted." :
    state.error ? errors[state.error] ?? "Network operation failed." : jobs[state.job] ?? state.job;
  document.querySelector("#network-job-status").dataset.error = String(Boolean(state.error));
  const committedProfile = JSON.stringify([state.desired_station, state.saved_ssid_hex || state.saved_ssid, state.requested_hostname]);
  const committedJob = networkFieldsJob === state.job_id && ["succeeded", "cancelled"].includes(state.job);
  if (!networkFieldsInitialized || (!state.busy && (renderedProfile !== committedProfile || committedJob))) {
    document.querySelector(`[name="network-mode"][value="${state.desired_station ? "station" : "ap"}"]`).checked = true;
    const input = document.querySelector("#wifi-ssid");
    input.value = state.saved_ssid || "";
    if (state.saved_ssid_hex) input.dataset.ssidHex = state.saved_ssid_hex;
    else delete input.dataset.ssidHex;
    document.querySelector("#wifi-network").value = "";
    document.querySelector("#network-hostname").value = state.requested_hostname || "kb";
    networkFieldsInitialized = true;
    renderedProfile = committedProfile;
    if (!state.busy) networkFieldsJob = 0;
    renderNetwork();
    return;
  }
  const serialized = JSON.stringify(state.scan);
  if (renderedScan !== serialized) {
    const select = document.querySelector("#wifi-network");
    const selected = select.value;
    select.replaceChildren(new Option("Manual entry", ""));
    for (const result of state.scan ?? []) {
      const option = new Option(`${result.ssid || "Hidden network"} (${result.rssi} dBm)${result.supported ? "" : " - unsupported"}`, result.ssid_hex || "");
      option.dataset.ssid = result.ssid || "";
      option.disabled = !result.supported || !result.ssid_hex;
      select.add(option);
    }
    select.value = selected;
    renderedScan = serialized;
  }
}

async function pollNetwork() {
  if (!account.authenticated || document.hidden || networkPolling) return;
  if (networkTimer !== null) clearTimeout(networkTimer);
  networkTimer = null;
  networkPolling = true;
  try {
    networkState = await api("/api/v1/network/job");
    networkUncertain = false;
    renderNetwork();
  } catch (error) {
    networkUncertain = true;
    if (currentView === "network") renderNetwork();
  } finally {
    networkPolling = false;
    if (account.authenticated && currentView === "network" && !document.hidden) networkTimer = setTimeout(pollNetwork, 1000);
  }
}

async function submitNetwork(action, fields = {}) {
  if (networkMutating || networkUncertain) return;
  const resetsFields = ["connect", "ap", "station", "forget"].includes(action) ||
    (action === "cancel" && networkState?.job !== "scanning");
  disconnect();
  notify();
  networkMutating = true;
  renderNetwork();
  try {
    const result = await api(action === "scan" ? "/api/v1/network/scan" : "/api/v1/network", "POST",
      action === "scan" ? undefined : { action, ...fields });
    if (resetsFields) networkFieldsJob = result.job_id;
    if (action === "rename" && location.hostname.endsWith(".local") && result.management_url) {
      location.replace(result.management_url);
      return;
    }
    if (networkState) networkState = { ...networkState, job_id: result.job_id, busy: true, can_control: false, job: "queued", error: "" };
  } catch (error) {
    if (!error.status) networkUncertain = true;
    notify(errorMessage(error));
  } finally {
    clearNetworkPassword();
    networkMutating = false;
    renderNetwork();
    pollNetwork();
  }
}

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

function disconnect() {
  controlAttempt++;
  takingControl = false;
  const previous = socket;
  socket = null;
  ready = false;
  keyboard.clear();
  keyboard.setCapsLock(null);
  pending.clear();
  sequence = 0;
  lastReport = JSON.stringify(keyboard.report);
  connectionStatus.textContent = account.authenticated ? "Released" : "Signed out";
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
  renderAccount();
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
  if (socket !== null || !account.authenticated || currentView !== "keyboard" || document.hidden || !document.hasFocus()) return;
  const endpoint = new URL("/api/v1/keyboard", location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(endpoint);
  socket = connection;
  renderAccount();
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
      if (ready && !surface.contains(document.activeElement)) surface.focus({ preventScroll: true });
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
document.querySelector("#release").addEventListener("click", () => {
  disconnect();
  api("/api/v1/control/stop", "POST").catch(error => notify(errorMessage(error)));
});
document.querySelector("#take-control").addEventListener("click", async () => {
  if (!account.authenticated || takingControl) return;
  const attempt = ++controlAttempt;
  takingControl = true;
  notify();
  renderAccount();
  try {
    await api("/api/v1/control/take", "POST");
    if (attempt !== controlAttempt || document.hidden || !document.hasFocus()) {
      await api("/api/v1/control/stop", "POST");
      return;
    }
    connect();
  } catch (error) {
    notify(errorMessage(error));
  } finally {
    takingControl = false;
    renderAccount();
  }
});
document.querySelector("#logout").addEventListener("click", async () => {
  clearNetworkPassword();
  disconnect();
  try {
    account = await api("/api/v1/session", "DELETE");
    document.querySelector("#account-form").reset();
    notify();
    disconnect();
  } catch (error) { notify(errorMessage(error)); }
});
document.querySelector("#account-form").addEventListener("reset", event => {
  for (const button of event.currentTarget.querySelectorAll("[data-password-toggle]")) setPasswordVisibility(button, false);
});
document.querySelector("#account-form").addEventListener("submit", async event => {
  event.preventDefault();
  disconnect();
  notify();
  const password = document.querySelector("#owner-password").value;
  const passwordBytes = new TextEncoder().encode(password).length;
  if (passwordBytes < 12 || passwordBytes > 128 || password.includes("\0")) {
    notify(errorMessage({ code: "invalid_credentials" }));
    return;
  }
  const claiming = !account.claimed;
  if (claiming && password !== document.querySelector("#owner-password-confirm").value) {
    notify("Owner passwords do not match.");
    return;
  }
  document.querySelector("#account-submit").disabled = true;
  try {
    account = await api(claiming ? "/api/v1/claim" : "/api/v1/session", "POST",
      { password, ...(claiming ? { setup_code: document.querySelector("#setup-code").value } : {}) });
    accountLoaded = true;
    connectionStatus.textContent = "Released";
  } catch (error) {
    notify(errorMessage(error));
    if (claiming && error.status !== 400 && error.status !== 401) await loadSession();
  } finally {
    document.querySelector("#account-form").reset();
    renderAccount();
  }
});
for (const button of document.querySelectorAll("[data-password-toggle]")) button.addEventListener("click", () => {
  const input = document.getElementById(button.dataset.passwordToggle);
  setPasswordVisibility(button, input.type === "password");
});
document.querySelector("#session-retry").addEventListener("click", loadSession);
document.querySelector("#network-settings").addEventListener("click", async () => {
  disconnect();
  currentView = "network";
  networkFieldsInitialized = false;
  renderedScan = "";
  notify();
  renderAccount();
  renderNetwork();
  try { await api("/api/v1/control/stop", "POST"); }
  catch (error) { notify(errorMessage(error)); }
  await pollNetwork();
});
document.querySelector("#network-back").addEventListener("click", () => {
  clearNetworkPassword();
  currentView = "keyboard";
  if (networkTimer !== null) clearTimeout(networkTimer);
  networkTimer = null;
  notify();
  renderAccount();
});
for (const radio of document.querySelectorAll('[name="network-mode"]')) radio.addEventListener("change", renderNetwork);
document.querySelector("#wifi-network").addEventListener("change", event => {
  const input = document.querySelector("#wifi-ssid");
  const option = event.target.selectedOptions[0];
  if (event.target.value && option?.dataset.ssid !== undefined) {
    input.value = option.dataset.ssid;
    input.dataset.ssidHex = event.target.value;
  } else delete input.dataset.ssidHex;
});
document.querySelector("#wifi-ssid").addEventListener("input", event => delete event.target.dataset.ssidHex);
document.querySelector("#network-scan").addEventListener("click", () => submitNetwork("scan"));
document.querySelector("#network-cancel").addEventListener("click", () => submitNetwork("cancel"));
document.querySelector("#network-confirm").addEventListener("click", () => submitNetwork("confirm"));
document.querySelector("#network-use-saved").addEventListener("click", () => submitNetwork("station"));
document.querySelector("#network-retry").addEventListener("click", pollNetwork);
document.querySelector("#network-form").addEventListener("submit", event => {
  event.preventDefault();
  if (document.querySelector('[name="network-mode"]:checked').value === "ap") { submitNetwork("ap"); return; }
  const input = document.querySelector("#wifi-ssid");
  const ssid = input.value;
  const ssidHex = input.dataset.ssidHex;
  const password = document.querySelector("#wifi-password").value;
  const ssidLength = ssidHex ? ssidHex.length / 2 : new TextEncoder().encode(ssid).length;
  if (ssidLength < 1 || ssidLength > 32 || !/^[\x20-\x7e]{8,63}$/.test(password)) {
    notify("Use an SSID of at most 32 bytes and an 8 to 63 character WPA2 password.");
    return;
  }
  submitNetwork("connect", ssidHex ? { ssid_hex: ssidHex, password } : { ssid, password });
});
document.querySelector("#hostname-form").addEventListener("submit", event => {
  event.preventDefault();
  submitNetwork("rename", { hostname: document.querySelector("#network-hostname").value });
});
document.querySelector("#forget-network").addEventListener("click", () => {
  document.querySelector("#forget-ssid").textContent = networkState?.saved_ssid || "";
  document.querySelector("#forget-dialog").showModal();
});
document.querySelector("#forget-dismiss").addEventListener("click", () => document.querySelector("#forget-dialog").close());
document.querySelector("#forget-confirm").addEventListener("click", () => {
  document.querySelector("#forget-dialog").close();
  submitNetwork("forget");
});
function suspendPage() {
  clearNetworkPassword();
  disconnect();
}
for (const event of ["blur", "pagehide"]) window.addEventListener(event, suspendPage);
document.addEventListener("visibilitychange", () => { if (document.hidden) suspendPage(); else loadSession(); });

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
renderAccount();
loadSession();