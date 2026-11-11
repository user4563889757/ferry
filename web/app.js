const $ = (selector) => document.querySelector(selector);
const CHUNK = 1024 * 1024;
const ROLE_STORE = "ferry.role";
const KEY_STORE = "ferry.key";
const TOKEN_STORE = "ferry.uploads";

// The share key is kept only for building links. Authentication itself uses the
// HttpOnly session cookie; this copy is session-scoped and never leaves the tab.
const state = {
  key: "",
  role: "",
  config: null,
  info: null,
  capacity: 0,
  files: [],
  queue: [],
  pumping: false,
  poll: null,
  resumeTarget: null,
  shareAfterUnlock: false,
  pendingFile: null,
  qrUrl: "",
  unlockRole: "receive",
  pendingUnlockMessage: "",
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function readSession(key) {
  try {
    return sessionStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSession(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* private mode or storage disabled */
  }
}

function removeSession(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function loadStoredKey() {
  return readSession(KEY_STORE);
}

function storeKey(value) {
  state.key = value;
  if (value) writeSession(KEY_STORE, value);
  else removeSession(KEY_STORE);
}

function forgetKey() {
  storeKey("");
}

function loadUploadTokens() {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORE);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveUploadToken(fingerprint, id, token) {
  const tokens = loadUploadTokens();
  tokens[fingerprint] = { id, token, at: Date.now() };
  const fresh = Object.entries(tokens)
    .filter(([, value]) => Date.now() - Number(value.at || 0) < 24 * 60 * 60 * 1000)
    .slice(-20);
  try {
    sessionStorage.setItem(TOKEN_STORE, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    /* ignore */
  }
}

function forgetUploadToken(fingerprint) {
  const tokens = loadUploadTokens();
  if (!(fingerprint in tokens)) return;
  delete tokens[fingerprint];
  try {
    sessionStorage.setItem(TOKEN_STORE, JSON.stringify(tokens));
  } catch {
    /* ignore */
  }
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
}

function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", isError);
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 3200);
}

function setStatus(kind, text) {
  const node = $("#status");
  node.className = `status ${kind}`;
  node.textContent = text;
}

function showRoleDialog() {
  const dialog = $("#role-dialog");
  if (!dialog.open) dialog.showModal();
}

function showUnlock(message = "", role = "receive") {
  state.unlockRole = role === "send" ? "send" : "receive";
  const roleDialog = $("#role-dialog");
  if (roleDialog.open) roleDialog.close();
  const dialog = $("#unlock-dialog");
  const error = $("#unlock-error");
  error.hidden = !message;
  error.textContent = message;
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#key-input").focus(), 30);
}

async function api(path, options = {}) {
  const { authPrompt = true, ...init } = options;
  const headers = new Headers(init.headers || {});
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  if (response.status === 401) {
    if (authPrompt) {
      forgetKey();
      fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
      showUnlock("That key did not work.", state.role === "send" ? "send" : "receive");
    }
    throw new ApiError("unauthorized", 401, null);
  }
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    throw new ApiError((data && data.message) || response.statusText, response.status, data);
  }
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}

function shareUrls(fileId = "") {
  if (!state.key) return [];
  const interfaces = (state.info && state.info.interfaces) || [];
  const key = encodeURIComponent(state.key);
  const file = fileId ? `&file=${encodeURIComponent(fileId)}` : "";
  const urls = interfaces.map((item) => ({
    label: item.bluetooth ? `${item.name} (Bluetooth PAN)` : item.name,
    url: `${item.url}#key=${key}${file}`,
    bluetooth: item.bluetooth,
  }));
  if (!urls.length) {
    urls.push({
      label: "this device",
      url: `${location.origin}/#key=${key}${file}`,
      bluetooth: false,
    });
  }
  return urls;
}

function bestUrl(fileId = "") {
  const urls = shareUrls(fileId);
  if (!urls.length) return `${location.origin}/`;
  return (urls.find((item) => !item.bluetooth) || urls[0]).url;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    window.prompt("Copy this link:", text);
  }
}

async function renderShare() {
  const urls = shareUrls();
  const container = $("#share-urls");
  container.replaceChildren();
  for (const item of urls) {
    const row = document.createElement("div");
    row.className = "url";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const code = document.createElement("code");
    code.textContent = item.url;
    row.append(label, code);
    container.append(row);
  }

  if (state.config && state.config.public_send) {
    const row = document.createElement("div");
    row.className = "url";
    const label = document.createElement("strong");
    label.textContent = "Send-only link (no key)";
    const code = document.createElement("code");
    code.textContent = `${location.origin}/#send`;
    row.append(label, code);
    container.append(row);
  }

  const response = await fetch("/api/qr", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: bestUrl() }),
  });
  if (!response.ok) throw new ApiError("Could not build the QR code.", response.status, null);
  const blob = await response.blob();
  if (state.qrUrl) URL.revokeObjectURL(state.qrUrl);
  state.qrUrl = URL.createObjectURL(blob);
  $("#qr-image").src = state.qrUrl;
}

async function openShare() {
  if (!state.key || state.role !== "receive") {
    state.shareAfterUnlock = true;
    showUnlock("Enter the share key to create a link.", "receive");
    return;
  }
  try {
    await renderShare();
    $("#share-dialog").showModal();
  } catch (error) {
    if (error.status !== 401) toast(error.message, true);
  }
}

async function loadConfig() {
  try {
    state.config = await api("/api/config", { authPrompt: false });
  } catch {
    state.config = {
      mode: "local",
      public_send: false,
      max_public_file: 350 * 1024 * 1024,
      public_expiry_hours: 0,
      capacity: 0,
    };
  }
  if (state.config.capacity) state.capacity = state.config.capacity;
  return state.config;
}

async function loadInfo() {
  state.info = await api("/api/info");
  state.capacity = state.info.capacity || state.capacity;
  setStatus("online", state.info.device_name || "online");
  const count = state.info.interfaces.filter((item) => !item.bluetooth).length;
  $("#server-line").textContent = `${state.info.device_name} · v${state.info.version} · ${count || 1} network address${count === 1 ? "" : "es"}`;
  const cloud = state.info.mode === "cloud";
  $("#bt-panel").hidden = cloud || state.role === "send";

  if (state.role === "receive") {
    $("#lede").textContent = cloud
      ? "Everything sent to this Ferry. Only someone with the share key can see, download, or delete it."
      : "Drop anything here. It stays on this Ferry until you delete it, and interrupted uploads resume where they stopped.";
    $("#footer-note").textContent = cloud
      ? "Open source · MIT · Cloudflare-hosted"
      : "Open source · MIT · resumable transfers";
    if (cloud) {
      $("#share-copy").textContent =
        "The key comes after the #, so it is not sent to the server or written to access logs. Anyone with it can reach this Ferry.";
    }
  }
}

async function loadFiles() {
  const data = await api("/api/files");
  state.files = data.files || [];
  renderFiles(data.stats);
}

function downloadFile(id, name = "") {
  const link = document.createElement("a");
  link.href = `/api/files/${encodeURIComponent(id)}/download`;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function fileRow(file) {
  const row = document.createElement("div");
  row.className = "row";

  const main = document.createElement("div");
  main.className = "row-main";
  const name = document.createElement("div");
  name.className = "row-name";
  name.textContent = file.name;
  name.title = file.name;
  const meta = document.createElement("div");
  meta.className = "row-meta";
  const visibility = file.visibility === "public" ? " · public drop" : "";
  const expiry = file.expires_at
    ? ` · expires ${new Date(file.expires_at * 1000).toLocaleString()}`
    : "";
  meta.textContent = `${fmtBytes(file.size)} · ${new Date(file.created_at * 1000).toLocaleString()}${visibility}${expiry}`;
  main.append(name, meta);

  if (file.status === "uploading") {
    const progress = document.createElement("progress");
    progress.max = file.size || 1;
    progress.value = file.offset;
    const status = document.createElement("div");
    status.className = "row-meta";
    status.textContent = `interrupted at ${fmtBytes(file.offset)}`;
    main.append(progress, status);
  }

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const action = document.createElement("button");
  action.className = "btn small";
  action.type = "button";
  if (file.status === "complete") {
    action.textContent = "Download";
    action.addEventListener("click", () => downloadFile(file.id, file.name));
  } else {
    action.textContent = "Resume";
    action.addEventListener("click", () => resumeFile(file));
  }

  const copyButton = document.createElement("button");
  copyButton.className = "btn small";
  copyButton.type = "button";
  copyButton.textContent = "Link";
  copyButton.addEventListener("click", async () => {
    if (!state.key) {
      state.shareAfterUnlock = true;
      showUnlock("Enter the share key to create a link.", "receive");
      return;
    }
    await copy(file.status === "complete" ? bestUrl(file.id) : bestUrl());
  });

  const deleteButton = document.createElement("button");
  deleteButton.className = "btn small danger";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    if (!confirm(`Delete ${file.name}?`)) return;
    try {
      await api(`/api/files/${file.id}`, { method: "DELETE" });
      await loadFiles();
      toast("Deleted.");
    } catch (error) {
      if (error.status !== 401) toast(error.message, true);
    }
  });

  actions.append(action, copyButton, deleteButton);
  row.append(main, actions);
  return row;
}

function renderFiles(stats) {
  const activeIds = new Set(
    state.queue
      .filter((item) => item.id && ["queued", "preparing", "uploading", "retrying"].includes(item.status))
      .map((item) => item.id),
  );
  const files = state.files.filter((file) => !activeIds.has(file.id));
  const list = $("#file-list");
  list.replaceChildren(...files.map(fileRow));
  $("#files-empty").hidden = files.length > 0;

  const complete = stats ? stats.count : files.filter((file) => file.status === "complete").length;
  const bytes = stats ? stats.bytes : files.reduce((sum, file) => sum + Number(file.offset || 0), 0);
  const capacity = (stats && stats.capacity) || state.capacity || 0;
  if (complete || bytes) {
    const percent = capacity ? Math.round((bytes / capacity) * 100) : 0;
    const usage = capacity ? ` · ${fmtBytes(bytes)} of ${fmtBytes(capacity)} (${percent}%)` : ` · ${fmtBytes(bytes)}`;
    const warning = capacity && bytes / capacity >= 0.85 ? " · almost full" : "";
    const publicCount = stats && stats.public_files ? ` · ${stats.public_files} public` : "";
    $("#files-summary").textContent = `${complete} file${complete === 1 ? "" : "s"}${usage}${publicCount}${warning}`;
  } else {
    $("#files-summary").textContent = "waiting for the first file";
  }
}

function queueRow(item) {
  const row = document.createElement("div");
  row.className = "row";

  const main = document.createElement("div");
  main.className = "row-main";
  const name = document.createElement("div");
  name.className = "row-name";
  name.textContent = item.file.name;
  const meta = document.createElement("div");
  meta.className = "row-meta";
  const stateText = document.createElement("span");
  stateText.className = "state" + (item.status === "error" ? " error" : "");
  stateText.textContent = {
    queued: "queued",
    preparing: "checking",
    uploading: `${Math.round((item.offset / item.file.size) * 100) || 0}%`,
    retrying: "reconnecting",
    done: "sent",
    error: "paused",
  }[item.status] || item.status;
  meta.append(stateText);
  if (item.status === "uploading" || item.status === "retrying") {
    const detail = document.createElement("span");
    const speed = item.speed ? ` · ${fmtBytes(item.speed)}/s` : "";
    const eta = item.eta ? ` · ${fmtTime(item.eta)} left` : "";
    detail.textContent = `${fmtBytes(item.offset)} / ${fmtBytes(item.file.size)}${speed}${eta}`;
    meta.append(detail);
  } else if (item.status === "error") {
    const detail = document.createElement("span");
    detail.textContent = item.error || "connection lost";
    meta.append(detail);
  } else if (item.status === "done") {
    const detail = document.createElement("span");
    detail.textContent = fmtBytes(item.file.size);
    meta.append(detail);
  }
  main.append(name, meta);

  const progress = document.createElement("progress");
  progress.max = item.file.size || 1;
  progress.value = item.status === "done" ? item.file.size : item.offset;
  main.append(progress);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (item.status === "error") {
    const retry = document.createElement("button");
    retry.className = "btn small";
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      item.status = "queued";
      item.error = "";
      renderQueue();
      pump();
    });
    actions.append(retry);
  }
  if (item.status === "done" || item.status === "error") {
    const dismiss = document.createElement("button");
    dismiss.className = "btn small";
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      state.queue = state.queue.filter((entry) => entry !== item);
      renderQueue();
      if (state.role === "receive") loadFiles().catch(() => {});
    });
    actions.append(dismiss);
  }

  row.append(main, actions);
  return row;
}

function renderQueue() {
  const list = $("#queue");
  list.replaceChildren(...state.queue.map(queueRow));
  $("#queue-empty").hidden = state.queue.length > 0;
  const active = state.queue.filter((item) => item.status !== "done" && item.status !== "error").length;
  $("#queue-count").textContent = active
    ? `${active} in flight`
    : state.queue.length
      ? "all caught up"
      : "nothing in flight";
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (state.resumeTarget) {
    const file = files[0];
    const target = state.resumeTarget;
    state.resumeTarget = null;
    if (file.name !== target.name || file.size !== target.size) {
      toast(`Choose ${target.name} (${fmtBytes(target.size)}) to resume.`, true);
      return;
    }
  }
  for (const file of files) {
    state.queue.push({ file, status: "queued", offset: 0, id: null, token: "", error: "", speed: 0, eta: 0 });
  }
  renderQueue();
  pump();
}

function resumeFile(file) {
  state.resumeTarget = { name: file.name, size: file.size };
  $("#file-input").click();
}

async function upload(item) {
  const file = item.file;
  const isPublic = state.role === "send";
  const limit = isPublic
    ? (state.config && state.config.max_public_file) || 0
    : (state.info && state.info.max_file) || 0;
  if (limit && file.size > limit) {
    item.status = "error";
    item.error = `Files are limited to ${fmtBytes(limit)}${isPublic ? " for public sends" : ""}`;
    renderQueue();
    return;
  }
  item.status = "preparing";
  renderQueue();
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  const saved = loadUploadTokens()[fingerprint];
  const body = {
    name: file.name,
    size: file.size,
    mime: file.type || "",
    modified_at: file.lastModified,
    fingerprint,
  };
  if (isPublic && saved && saved.token) body.upload_token = saved.token;

  let meta = await api("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (isPublic && meta.upload_token) {
    item.token = meta.upload_token;
    saveUploadToken(fingerprint, meta.id, meta.upload_token);
  }

  if (meta.status === "complete") {
    item.status = "done";
    item.offset = file.size;
    renderQueue();
    forgetUploadToken(fingerprint);
    toast(isPublic ? "Sent. The receiver can see it." : "That file is already here.");
    if (state.role === "receive") await loadFiles();
    return;
  }

  item.id = meta.id;
  item.offset = meta.offset;
  item.status = "uploading";
  if (item.offset > 0) toast(`Resuming at ${fmtBytes(item.offset)}.`);
  renderQueue();
  let lastTime = performance.now();
  let lastOffset = item.offset;

  while (item.offset < file.size) {
    const end = Math.min(item.offset + CHUNK, file.size);
    const chunk = file.slice(item.offset, end);
    const headers = { "Content-Type": "application/octet-stream" };
    if (item.token) headers["X-Ferry-Upload"] = item.token;
    try {
      const updated = await api(`/api/uploads/${item.id}?offset=${item.offset}`, {
        method: "PUT",
        headers,
        body: chunk,
      });
      item.offset = updated.offset;
      item.error = "";
      item.status = "uploading";
      const now = performance.now();
      const elapsed = (now - lastTime) / 1000;
      if (elapsed > 0.25) {
        item.speed = (item.offset - lastOffset) / elapsed;
        item.eta = item.speed > 0 ? (file.size - item.offset) / item.speed : 0;
        lastTime = now;
        lastOffset = item.offset;
      }
      renderQueue();
    } catch (error) {
      if (error.status === 401) return;
      if (error.status === 409 && error.data && Number.isFinite(error.data.offset)) {
        item.offset = error.data.offset;
        renderQueue();
        continue;
      }
      if (error.status === 403 && isPublic) {
        item.status = "error";
        item.error = "This public send expired. Add the file again.";
        renderQueue();
        return;
      }
      item.status = "retrying";
      item.error = error.message;
      renderQueue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const current = item.token
          ? await api(`/api/uploads/${item.id}`, {
              headers: { "X-Ferry-Upload": item.token },
              authPrompt: false,
            })
          : await api(`/api/files/${item.id}`);
        item.offset = current.offset;
        item.status = "uploading";
        renderQueue();
        continue;
      } catch (refreshError) {
        if (refreshError.status === 401) return;
        item.status = "error";
        item.error = refreshError.status === 410 ? "This upload expired" : "Connection lost";
        renderQueue();
        return;
      }
    }
  }

  item.status = "done";
  item.offset = file.size;
  renderQueue();
  forgetUploadToken(fingerprint);
  toast(isPublic ? `Sent ${file.name}. The receiver can see it.` : `Sent ${file.name}.`);
  if (state.role === "receive") await loadFiles();
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (true) {
      const item = state.queue.find((entry) => entry.status === "queued");
      if (!item) break;
      await upload(item);
    }
  } catch (error) {
    if (error.status !== 401) toast(error.message, true);
    const current = state.queue.find((entry) => entry.status === "preparing" || entry.status === "uploading");
    if (current) {
      current.status = "error";
      current.error = error.message;
    }
    renderQueue();
  } finally {
    state.pumping = false;
    renderQueue();
  }
}

async function probeSession() {
  try {
    const response = await fetch("/api/info", { credentials: "same-origin" });
    if (!response.ok) return false;
    state.info = await response.json();
    state.capacity = state.info.capacity || state.capacity;
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  try {
    await loadInfo();
    await loadFiles();
    if (!state.poll) {
      state.poll = setInterval(() => {
        if (document.visibilityState === "visible" && state.role === "receive") {
          loadFiles().catch(() => {});
        }
      }, 15000);
    }
  } catch (error) {
    if (error.status !== 401) {
      setStatus("offline", "offline");
      toast("Cannot reach the Ferry server.", true);
    }
  }
}

async function unlockWithKey(value) {
  const response = await fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-Ferry-Key": value },
  });
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    throw new ApiError(
      (data && data.message) || "That share key did not work.",
      response.status,
      data,
    );
  }
  storeKey(value);
}

function finishUnlock() {
  $("#unlock-dialog").close();
  $("#unlock-error").hidden = true;
  $("#key-input").value = "";
}

function downloadPending() {
  if (!state.pendingFile || state.role !== "receive") return;
  const id = state.pendingFile;
  state.pendingFile = null;
  downloadFile(id);
}

function setRole(role) {
  state.role = role;
  writeSession(ROLE_STORE, role);

  const send = role === "send";
  const receive = role === "receive";
  $("#files-panel").hidden = !receive;
  $("#share-btn").hidden = !receive;
  $("#lock-btn").hidden = !receive;
  $("#mode-btn").hidden = !role;
  $("#mode-btn").textContent = send ? "Receive files" : "Send files";
  $("#mode-note").hidden = !send;

  if (send) {
    if (state.poll) {
      clearInterval(state.poll);
      state.poll = null;
    }
    setStatus("online", "public send");
    $("#server-line").textContent = "Public drop box · no key needed";
    $("#lede").textContent = "Send a file to this Ferry.";
    $("#bt-panel").hidden = true;
    $("#footer-note").textContent = "Open source · MIT · public drop box";

    if (state.config && state.config.public_send) {
      const hours = state.config.public_expiry_hours;
      $("#mode-note").textContent =
        `Public sends: up to ${fmtBytes(state.config.max_public_file)} each, expire after ${hours} hour${hours === 1 ? "" : "s"}. Unlock with the key for larger files.`;
    } else {
      $("#mode-note").textContent =
        "This Ferry needs the share key to send. You will be asked once; the upload resumes after unlocking.";
    }
  } else if (receive) {
    $("#mode-note").hidden = true;
    if (state.info) {
      $("#bt-panel").hidden = state.info.mode === "cloud";
    }
  }

  renderFiles();
  renderQueue();
}

async function enterSend() {
  await loadConfig();
  const dialog = $("#role-dialog");
  if (dialog.open) dialog.close();
  setRole("send");
}

async function enterReceive(message = "") {
  const authed = await probeSession();
  if (!authed) {
    const note = message || state.pendingUnlockMessage || "Enter the share key to see files.";
    state.pendingUnlockMessage = "";
    showUnlock(note, "receive");
    return;
  }
  state.pendingUnlockMessage = "";
  const dialog = $("#role-dialog");
  if (dialog.open) dialog.close();
  setRole("receive");
  await boot();
  downloadPending();
}

async function initKey() {
  state.key = loadStoredKey();
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get("key");
  const file = params.get("file");
  const wantsSend = params.has("send");
  if (file && /^[a-f0-9]{32}$/.test(file)) state.pendingFile = file;
  if (wantsSend) writeSession(ROLE_STORE, "send");
  if (fromHash || file) writeSession(ROLE_STORE, "receive");
  if (fromHash) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      await unlockWithKey(fromHash);
    } catch (error) {
      forgetKey();
      state.pendingUnlockMessage = error.message;
    }
  } else if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function initEvents() {
  const drop = $("#drop-zone");
  const input = $("#file-input");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  for (const name of ["dragenter", "dragover"]) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
    });
  }
  drop.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });

  $("#role-send").addEventListener("click", () => enterSend());
  $("#role-receive").addEventListener("click", () => enterReceive());
  $("#mode-btn").addEventListener("click", async () => {
    if (state.role === "send") await enterReceive();
    else await enterSend();
  });
  $("#share-btn").addEventListener("click", openShare);
  $("#copy-link").addEventListener("click", async () => {
    if (!state.key) {
      state.shareAfterUnlock = true;
      showUnlock("Enter the share key to create a link.", "receive");
      return;
    }
    await copy(bestUrl());
  });
  $("#refresh-btn").addEventListener("click", () => loadFiles().catch((error) => {
    if (error.status !== 401) toast(error.message, true);
  }));
  $("#lock-btn").addEventListener("click", async () => {
    await fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
    forgetKey();
    removeSession(ROLE_STORE);
    if (state.poll) {
      clearInterval(state.poll);
      state.poll = null;
    }
    location.replace(location.pathname);
  });

  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
  }

  $("#unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = $("#key-input").value.trim();
    if (!value) return;
    const role = state.unlockRole || "receive";
    try {
      await unlockWithKey(value);
      finishUnlock();
      if (role === "send") {
        await enterSend();
        for (const item of state.queue) {
          if (item.status === "error") {
            item.status = "queued";
            item.error = "";
          }
        }
        pump();
      } else {
        const wantsShare = state.shareAfterUnlock;
        state.shareAfterUnlock = false;
        await enterReceive();
        if (wantsShare) await openShare();
      }
    } catch (error) {
      forgetKey();
      showUnlock(error.message || "That share key did not work.", role);
    }
  });
}

async function chooseRole() {
  const saved = readSession(ROLE_STORE);
  if (saved === "send") {
    await enterSend();
    return;
  }
  if (saved === "receive") {
    await enterReceive();
    return;
  }
  if (await probeSession()) {
    setRole("receive");
    await boot();
    downloadPending();
    return;
  }
  showRoleDialog();
}

async function main() {
  await initKey();
  initEvents();
  renderQueue();
  renderFiles();
  await chooseRole();
}

main();
