let account = { provisioned: false, claimed: false, authenticated: false, csrf: "" };
let accountLoaded = false;
let accountLoading = false;
let firmwareState = null;
let firmwareJob = null;
let firmwareTimer = null;
let firmwarePolling = false;
let firmwareMutating = false;
let firmwareRevision = 0;
let firmwareUpload = null;
let firmwareTransferred = 0;
let firmwareOutcome = "";
let firmwareUncertain = false;
let expectedFirmware = "";
try { expectedFirmware = sessionStorage.getItem("keyboard.pending-firmware.v1") ?? ""; } catch {}

function notify(message = "") {
  const output = document.querySelector("#ui-message");
  output.textContent = message;
  output.hidden = !message;
}

function errorMessage(error) {
  return ({ invalid_credentials: "Owner password not accepted. Use 12 to 128 bytes.",
    login_rate_limited: "Too many attempts. Try again in a minute.",
    csrf_denied: "Session changed. Reload and sign in again.",
    provisioning_required: "Device provisioning is required.", claim_required: "Owner setup has not been completed.",
    release_control_first: "Keyboard control is active. Update unavailable.",
    network_busy: "Network operation in progress. Try again shortly.",
    update_unavailable_or_busy: "Firmware update is unavailable or another operation is in progress.",
    invalid_update_request: "Select a compatible signed firmware image within the size limit.",
    update_failed: "Firmware verification or transfer failed. The running version is unchanged.",
    update_not_ready: "This update is no longer ready. Refresh its status.",
    update_owner_required: "This update belongs to another session.", login_required: "Sign in to continue."
  })[error.code] ?? "Cannot reach the device. Check the connection and try again.";
}

function passwordVisibility(revealed) {
  document.querySelector("#owner-password").type = revealed ? "text" : "password";
  const button = document.querySelector("#password-toggle");
  button.querySelector(".icon").dataset.icon = revealed ? "eye-off" : "eye";
  button.title = `${revealed ? "Hide" : "Show"} password`;
  button.setAttribute("aria-label", button.title);
}

function clearPassword() {
  document.querySelector("#owner-password").value = "";
  passwordVisibility(false);
}

function renderAccount() {
  document.querySelector("#account-view").hidden = account.authenticated;
  document.querySelector("#firmware-view").hidden = !account.authenticated;
  document.querySelector("#logout").hidden = !account.authenticated;
  document.querySelector("#logout").disabled = accountLoading;
  document.querySelector("#account-submit").disabled = accountLoading || !accountLoaded || !account.provisioned || !account.claimed;
  document.querySelector("#connection-status").textContent = account.authenticated ? "Signed in" : accountLoaded ? "Signed out" : "Loading";
}

function resetSession() {
  firmwareRevision++;
  account.authenticated = false;
  account.csrf = "";
  firmwareUpload?.abort();
  firmwareState = firmwareJob = null;
  clearTimeout(firmwareTimer);
  firmwareTimer = null;
  clearPassword();
  renderAccount();
}

async function api(path, method = "GET", body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && account.csrf) headers["X-CSRF-Token"] = account.csrf;
  const response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.timeout(method === "POST" && path === "/api/v1/session" ? 30000 : 5000),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    const error = Object.assign(new Error(result.error ?? "request_failed"), { code: result.error, status: response.status });
    if (response.status === 401 && !(method === "POST" && path === "/api/v1/session")) resetSession();
    throw error;
  }
  return result;
}

async function loadSession() {
  if (accountLoading) return;
  accountLoading = true;
  renderAccount();
  try {
    account = await api("/api/v1/session");
    accountLoaded = true;
    document.querySelector("#session-retry").hidden = true;
    if (!account.authenticated) resetSession();
    notify(!account.provisioned ? "Device provisioning is required." : !account.claimed ? "Owner setup has not been completed." : "");
    if (account.authenticated) pollFirmware();
  } catch (error) {
    notify(errorMessage(error));
    document.querySelector("#session-retry").hidden = false;
  } finally {
    accountLoading = false;
    renderAccount();
  }
}

function renderFirmware() {
  const phase = firmwareJob?.phase ?? (firmwareState?.busy ? "busy" : "idle");
  const locked = !account.authenticated || !firmwareState?.available || firmwareState.busy || firmwareUpload !== null ||
    firmwareMutating || firmwareUncertain || Boolean(expectedFirmware);
  document.querySelector("#firmware-version").textContent = firmwareState?.version ?? "-";
  document.querySelector("#firmware-board").textContent = firmwareState?.board ?? "-";
  document.querySelector("#firmware-profile").textContent = firmwareState ? (firmwareState.test_only ? "Test build" : "Release build") : "-";
  document.querySelector("#firmware-candidate").textContent = firmwareJob?.candidate_version || "None";
  document.querySelector("#firmware-file").disabled = locked;
  document.querySelector("#firmware-upload").disabled = locked || !document.querySelector("#firmware-file").files.length;
  document.querySelector("#firmware-activate").hidden = phase !== "staged" || Boolean(expectedFirmware);
  document.querySelector("#firmware-activate").disabled = firmwareMutating || firmwareUpload !== null || firmwareUncertain;
  document.querySelector("#firmware-cancel").hidden = !["receiving", "verifying", "staged"].includes(phase) && firmwareUpload === null;
  document.querySelector("#firmware-cancel").disabled = firmwareMutating;
  const progress = document.querySelector("#firmware-progress");
  progress.hidden = !["receiving", "verifying", "staged"].includes(phase) && firmwareUpload === null;
  progress.value = firmwareUpload ? firmwareTransferred : firmwareJob?.expected ? Math.min(100, firmwareJob.received / firmwareJob.expected * 100) : 0;
  const phases = { idle: firmwareState?.available ? "Ready" : "Checking device", busy: "Update in another session",
    receiving: "Uploading", verifying: "Verifying image", staged: "Image verified; ready to install", activating: "Restarting",
    failed: "Update failed; running firmware retained", cancelled: "Update cancelled" };
  document.querySelector("#firmware-status").textContent = firmwareOutcome || (expectedFirmware ? "Restart requested; checking running version" :
    firmwareUpload ? (firmwareTransferred >= 100 ? "Transfer complete; waiting for verification" : "Uploading") : phases[phase]);
  document.querySelector("#firmware-status").dataset.error = String(phase === "failed");
  renderAccount();
}

async function pollFirmware() {
  if (!account.authenticated || document.hidden || firmwarePolling || firmwareMutating) return;
  clearTimeout(firmwareTimer);
  firmwarePolling = true;
  const csrf = account.csrf;
  const revision = firmwareRevision;
  try {
    const information = await api("/api/v1/firmware");
    if (!account.authenticated || account.csrf !== csrf || revision !== firmwareRevision) return;
    let job = null;
    try {
      job = await api("/api/v1/update/job");
    } catch (error) {
      if (error.code !== "update_owner_required") throw error;
    }
    if (!account.authenticated || account.csrf !== csrf || revision !== firmwareRevision) return;
    firmwareState = job ?? information;
    firmwareJob = job;
    if (firmwareUncertain) {
      firmwareOutcome = "";
      firmwareUncertain = false;
      notify();
    }
    if (expectedFirmware && firmwareJob?.phase === "staged" && firmwareJob.candidate_version === expectedFirmware) {
      expectedFirmware = "";
      firmwareOutcome = "";
      try { sessionStorage.removeItem("keyboard.pending-firmware.v1"); } catch {}
      notify();
    }
    if (expectedFirmware && !firmwareState.busy && !firmwareState.trial_boot) {
      firmwareOutcome = firmwareState.version === expectedFirmware ? `Version ${expectedFirmware} is running` :
        `Update not confirmed; version ${firmwareState.version} is running`;
      expectedFirmware = "";
      try { sessionStorage.removeItem("keyboard.pending-firmware.v1"); } catch {}
    }
    renderFirmware();
  } catch (error) {
    if (revision !== firmwareRevision) return;
    firmwareUncertain = true;
    firmwareOutcome = expectedFirmware ? "Restarting; sign in again when the device returns" : errorMessage(error);
    renderFirmware();
  } finally {
    firmwarePolling = false;
    if (account.authenticated && !document.hidden) firmwareTimer = setTimeout(pollFirmware, 500);
  }
}

async function uploadFirmware(event) {
  event.preventDefault();
  const file = document.querySelector("#firmware-file").files[0];
  if (!account.authenticated || !file || firmwareUpload || firmwareState?.busy || firmwareMutating || firmwareUncertain) return;
  if (file.size < 8192 || file.size > (firmwareState?.max_bytes ?? 0) || file.size % 4096) {
    notify(errorMessage({ code: "invalid_update_request" }));
    return;
  }
  notify();
  firmwareOutcome = "";
  firmwareJob = null;
  firmwareTransferred = 0;
  const csrf = account.csrf;
  const upload = new XMLHttpRequest();
  firmwareUpload = upload;
  renderFirmware();
  try {
    await new Promise((resolve, reject) => {
      upload.open("POST", "/api/v1/update");
      upload.responseType = "json";
      upload.timeout = 300000;
      upload.setRequestHeader("Content-Type", "application/octet-stream");
      upload.setRequestHeader("X-CSRF-Token", csrf);
      upload.upload.onprogress = progress => {
        if (firmwareUpload !== upload) return;
        firmwareTransferred = progress.lengthComputable ? Math.min(100, progress.loaded / progress.total * 100) : 0;
        renderFirmware();
      };
      upload.onload = () => upload.status >= 200 && upload.status < 300 ? resolve() : reject({ code: upload.response?.error });
      upload.onerror = upload.ontimeout = () => reject({ code: "upload_unknown" });
      upload.onabort = () => reject({ code: "upload_cancelled" });
      upload.send(file);
    });
  } catch (error) {
    if (account.authenticated && account.csrf === csrf) {
      if (error.code === "upload_unknown") {
        firmwareUncertain = true;
        firmwareOutcome = "Upload response lost; checking device status";
      } else notify(error.code === "upload_cancelled" ? "Upload stopped" : errorMessage(error));
    }
  } finally {
    if (firmwareUpload === upload) firmwareUpload = null;
    document.querySelector("#firmware-file").value = "";
    renderFirmware();
    if (account.authenticated && account.csrf === csrf) await pollFirmware();
  }
}

async function firmwareCommand(activate) {
  if (!account.authenticated || firmwareMutating) return;
  const csrf = account.csrf;
  firmwareRevision++;
  firmwareMutating = true;
  firmwareOutcome = "";
  notify();
  renderFirmware();
  try {
    const job = !activate && !firmwareJob?.job_id ? await api("/api/v1/update/job") : firmwareJob;
    if (!account.authenticated || account.csrf !== csrf) return;
    if (!job?.job_id) {
      if (!activate) firmwareUpload?.abort();
      return;
    }
    if (!activate && !["receiving", "verifying", "staged"].includes(job.phase)) {
      firmwareUpload?.abort();
      firmwareJob = job;
      firmwareState = job;
      return;
    }
    if (activate) {
      expectedFirmware = job.candidate_version;
      try { sessionStorage.setItem("keyboard.pending-firmware.v1", expectedFirmware); } catch {}
      renderFirmware();
    }
    const result = await api(activate ? "/api/v1/update/activate" : "/api/v1/update/job", activate ? "POST" : "DELETE",
      { job_id: job.job_id, ...(activate ? { sha256: job.sha256 } : {}) });
    if (!account.authenticated || account.csrf !== csrf) return;
    firmwareJob = result;
    firmwareState = result;
    if (!activate) firmwareUpload?.abort();
  } catch (error) {
    if (activate && error.status) {
      expectedFirmware = "";
      try { sessionStorage.removeItem("keyboard.pending-firmware.v1"); } catch {}
    }
    notify(errorMessage(error));
  } finally {
    firmwareRevision++;
    firmwareMutating = false;
    renderFirmware();
    pollFirmware();
  }
}

document.querySelector("#account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (accountLoading || !accountLoaded || !account.provisioned || !account.claimed) return;
  const password = document.querySelector("#owner-password").value;
  const bytes = new TextEncoder().encode(password).length;
  if (bytes < 12 || bytes > 128) { notify(errorMessage({ code: "invalid_credentials" })); return; }
  accountLoading = true;
  renderAccount();
  notify();
  try {
    account = await api("/api/v1/session", "POST", { password });
    firmwareState = firmwareJob = null;
    firmwareOutcome = "";
    pollFirmware();
  } catch (error) { notify(errorMessage(error)); }
  finally { accountLoading = false; clearPassword(); renderAccount(); }
});
document.querySelector("#logout").addEventListener("click", async () => {
  if (accountLoading) return;
  accountLoading = true;
  renderAccount();
  try { await api("/api/v1/session", "DELETE"); notify(); }
  catch (error) { notify(errorMessage(error)); }
  finally { accountLoading = false; resetSession(); }
});
document.querySelector("#password-toggle").addEventListener("click", () => passwordVisibility(document.querySelector("#owner-password").type === "password"));
document.querySelector("#session-retry").addEventListener("click", loadSession);
document.querySelector("#firmware-file").addEventListener("change", renderFirmware);
document.querySelector("#firmware-form").addEventListener("submit", uploadFirmware);
document.querySelector("#firmware-refresh").addEventListener("click", () => { firmwareOutcome = ""; pollFirmware(); });
document.querySelector("#firmware-cancel").addEventListener("click", () => firmwareCommand(false));
document.querySelector("#firmware-activate").addEventListener("click", () => firmwareCommand(true));
window.addEventListener("blur", clearPassword);
window.addEventListener("pagehide", () => { clearPassword(); clearTimeout(firmwareTimer); firmwareUpload?.abort(); });
window.addEventListener("pageshow", loadSession);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearPassword(); clearTimeout(firmwareTimer); }
  else loadSession();
});
document.querySelector("#device-address").textContent = location.host;
renderAccount();
loadSession();