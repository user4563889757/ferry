export const CHUNK = 1024 * 1024;
// Keep a safety margin below the 500 MB free D1 database limit.
export const MAX_DB = 400 * 1024 * 1024;
// Downloads fetch chunks in batches so one request stays under the free
// plan's 50 D1 queries per invocation.
export const MAX_FILE = 350 * 1024 * 1024;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function apiError(status, error, message, extra = {}) {
  return json({ error, message, ...extra }, status);
}

export function conflict(offset) {
  return apiError(
    409,
    "offset_mismatch",
    "The upload offset has changed. Resume from the returned offset.",
    { offset },
  );
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function validId(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}

export function cleanName(raw) {
  const text = typeof raw === "string" ? raw : "";
  const base = text.split(/[\\/]/).pop() || "";
  const filtered = Array.from(base)
    .filter((character) => !/[\u0000-\u001f\u007f]/.test(character))
    .join("")
    .trim();
  return (filtered || "unnamed-file").slice(0, 200);
}

export function normalizeMime(raw, name) {
  if (typeof raw === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(raw.trim())) {
    return raw.trim().toLowerCase();
  }
  const extension = (name.split(".").pop() || "").toLowerCase();
  const common = {
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    pdf: "application/pdf",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    wav: "audio/wav",
    apk: "application/vnd.android.package-archive",
  };
  return common[extension] || "application/octet-stream";
}

export async function getMeta(env, id) {
  if (!validId(id)) return null;
  return env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first();
}

export async function storedBytes(env) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(offset), 0) AS bytes FROM files",
  ).first();
  return Number(row?.bytes || 0);
}

export async function findResume(env, fingerprint) {
  const uploading = await env.DB.prepare(
    "SELECT * FROM files WHERE fingerprint = ? AND status = 'uploading' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(fingerprint)
    .first();
  if (uploading) return uploading;
  return env.DB.prepare(
    "SELECT * FROM files WHERE fingerprint = ? AND status = 'complete' ORDER BY updated_at DESC LIMIT 1",
  )
    .bind(fingerprint)
    .first();
}
