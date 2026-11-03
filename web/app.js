const $ = (selector) => document.querySelector(selector);
const KEY_STORE = "ferry.key";
const CHUNK = 4 * 1024 * 1024;

const state = {
  key: localStorage.getItem(KEY_STORE) || "",
  info: null,
  files: [],
  queue: [],
  pumping: false,
  poll: null,
  resumeTarget: null,
};

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
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

function showUnlock(message = "") {
  const dialog = $("#unlock-dialog");
  const error = $("#unlock-error");
  error.hidden = !message;
  error.textContent = message;
  if (!dialog.open) dialog.showModal();
  setTimeout(() => $("#key-input").focus(), 30);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("X-Ferry-Key", state.key);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    state.key = "";
    localStorage.removeItem(KEY_STORE);
    showUnlock("That key did not work.");
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

function shareUrls() {
  const interfaces = (state.info && state.info.interfaces) || [];
  const key = encodeURIComponent(state.key);
  const urls = interfaces.map((item) => ({
    label: item.bluetooth ? `${item.name} (Bluetooth PAN)` : item.name,
    url: `${item.url}#key=${key}`,
    bluetooth: item.bluetooth,
  }));
  if (!urls.length) {
    urls.push({ label: "this device", url: `${location.origin}/#key=${key}`, bluetooth: false });
  }
  return urls;
}

function bestUrl() {
  const urls = shareUrls();
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

function renderShare() {
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
  $("#qr-image").src = `/api/qr?text=${encodeURIComponent(bestUrl())}&key=${encodeURIComponent(state.key)}`;
}

function openShare() {
  renderShare();
  $("#share-dialog").showModal();
}

async function loadInfo() {
  state.info = await api("/api/info");
  setStatus("online", state.info.device_name || "online");
  const count = state.info.interfaces.filter((item) => !item.bluetooth).length;
  $("#server-line").textContent = `${state.info.device_name} · v${state.info.version} · ${count || 1} network address${count === 1 ? "" : "es"}`;
}

async function loadFiles() {
  const data = await api("/api/files");
  state.files = data.files || [];
  renderFiles(data.stats);
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
  meta.textContent = `${fmtBytes(file.size)} · ${new Date(file.created_at * 1000).toLocaleString()}`;
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
    action.addEventListener("click", () => {
      const link = document.createElement("a");
      link.href = `/api/files/${file.id}/download?key=${encodeURIComponent(state.key)}`;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
    });
  } else {
    action.textContent = "Resume";
    action.addEventListener("click", () => resumeFile(file));
  }

  const copyButton = document.createElement("button");
  copyButton.className = "btn small";
  copyButton.type = "button";
  copyButton.textContent = "Link";
  copyButton.addEventListener("click", () => {
    const url = file.status === "complete"
      ? `${location.origin}/api/files/${file.id}/download?key=${encodeURIComponent(state.key)}`
      : bestUrl();
    copy(url);
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
  const bytes = stats ? stats.bytes : files.reduce((sum, file) => sum + (file.status === "complete" ? file.size : 0), 0);
  $("#files-summary").textContent = complete
    ? `${complete} file${complete === 1 ? "" : "s"} · ${fmtBytes(bytes)}`
    : "waiting for the first file";
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
      loadFiles().catch(() => {});
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
    state.queue.push({ file, status: "queued", offset: 0, id: null, error: "", speed: 0, eta: 0 });
  }
  renderQueue();
  pump();
}

function resumeFile(file) {
  state.resumeTarget = { name: file.name, size: file.size };
  $("#file-input").click();
}

async function upload(item) {
  item.status = "preparing";
  renderQueue();
  const file = item.file;
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  let meta = await api("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      mime: file.type || "",
      modified_at: file.lastModified,
      fingerprint,
    }),
  });

  if (meta.status === "complete") {
    item.status = "done";
    item.offset = file.size;
    renderQueue();
    toast("That file is already here.");
    await loadFiles();
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
    try {
      const updated = await api(`/api/uploads/${item.id}?offset=${item.offset}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
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
      item.status = "retrying";
      item.error = error.message;
      renderQueue();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const current = await api(`/api/files/${item.id}`);
        item.offset = current.offset;
        item.status = "uploading";
        renderQueue();
        continue;
      } catch (refreshError) {
        if (refreshError.status === 401) return;
        item.status = "error";
        item.error = "Connection lost";
        renderQueue();
        return;
      }
    }
  }

  item.status = "done";
  item.offset = file.size;
  renderQueue();
  toast(`Sent ${file.name}.`);
  await loadFiles();
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

async function boot() {
  if (!state.key) {
    showUnlock();
    return;
  }
  try {
    await loadInfo();
    await loadFiles();
    if (!state.poll) {
      state.poll = setInterval(() => {
        if (document.visibilityState === "visible") loadFiles().catch(() => {});
      }, 4000);
    }
  } catch (error) {
    if (error.status !== 401) {
      setStatus("offline", "offline");
      toast("Cannot reach the Ferry server.", true);
    }
  }
}

function initKey() {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromHash = params.get("key");
  if (fromHash) {
    state.key = fromHash;
    localStorage.setItem(KEY_STORE, fromHash);
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

  $("#share-btn").addEventListener("click", openShare);
  $("#copy-link").addEventListener("click", () => copy(bestUrl()));
  $("#refresh-btn").addEventListener("click", () => loadFiles().catch((error) => {
    if (error.status !== 401) toast(error.message, true);
  }));

  for (const button of document.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => document.getElementById(button.dataset.close).close());
  }

  $("#unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = $("#key-input").value.trim();
    if (!value) return;
    state.key = value;
    try {
      await loadInfo();
      localStorage.setItem(KEY_STORE, value);
      $("#unlock-dialog").close();
      $("#unlock-error").hidden = true;
      await loadFiles();
      boot();
    } catch (error) {
      state.key = "";
      localStorage.removeItem(KEY_STORE);
      showUnlock("That key did not work.");
    }
  });
}

async function main() {
  initKey();
  initEvents();
  renderQueue();
  renderFiles();
  await boot();
}

main();
