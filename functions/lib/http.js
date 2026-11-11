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

export function dayNumber() {
  return Math.floor(Date.now() / 86400000);
}

const textEncoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Public upload tokens are capabilities, not passwords: 24 random bytes are
// enough that the hash cannot be guessed. They are stored hashed so a database
// leak does not let someone append to an in-flight upload.
export function newUploadToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export function validUploadToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(token);
}

export async function hashUploadToken(token) {
  return sha256Hex(token);
}

// Hash the client IP with FERRY_KEY as a pepper so daily quotas can be tracked
// without storing raw addresses.
export async function clientHash(request, env) {
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  return sha256Hex(`${env.FERRY_KEY || "ferry"}:${address}`);
}

export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function envInt(env, name, fallback) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function publicConfig(env) {
  return {
    enabled: String(env?.PUBLIC_SEND || "0") === "1",
    max_file: Math.min(envInt(env, "PUBLIC_MAX_MB", 50) * 1024 * 1024, MAX_FILE),
    expiry_hours: Math.min(
      Math.max(envInt(env, "PUBLIC_EXPIRY_HOURS", 24), 1),
      24 * 30,
    ),
    daily_files: envInt(env, "PUBLIC_DAILY_FILES", 20),
    daily_bytes: Math.min(
      envInt(env, "PUBLIC_DAILY_MB", 200) * 1024 * 1024,
      MAX_DB,
    ),
    budget: Math.min(envInt(env, "PUBLIC_BUDGET_MB", 300) * 1024 * 1024, MAX_DB),
  };
}

// Never return capability hashes, sender hashes, or other internal columns to
// a client.
export function publicMeta(meta) {
  if (!meta) return meta;
  const {
    upload_token_hash: _tokenHash,
    sender_hash: _senderHash,
    ...rest
  } = meta;
  return rest;
}

export async function storedBytesBy(env, visibility) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(offset), 0) AS bytes FROM files WHERE visibility = ?",
  )
    .bind(visibility)
    .first();
  return Number(row?.bytes || 0);
}

// Expired public files are removed lazily so the free database cannot fill up
// with abandoned drops. Two statements, regardless of how many files expire.
export async function deleteExpired(env) {
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?",
    ).bind(now),
  ]);
}

export async function checkPublicQuota(env, request, size) {
  const config = publicConfig(env);
  if (!config.enabled) {
    return {
      ok: false,
      response: apiError(
        403,
        "send_disabled",
        "Public sending is disabled on this Ferry.",
      ),
    };
  }

  const day = dayNumber();
  const hash = await clientHash(request, env);
  const row = await env.DB.prepare(
    "SELECT files, bytes FROM send_quota WHERE ip_hash = ? AND day = ?",
  )
    .bind(hash, day)
    .first();
  const files = Number(row?.files || 0);
  const bytes = Number(row?.bytes || 0);

  if (config.daily_files > 0 && files + 1 > config.daily_files) {
    return {
      ok: false,
      response: apiError(
        429,
        "daily_limit",
        `This network can send ${config.daily_files} files per day to this Ferry.`,
      ),
    };
  }
  if (config.daily_bytes > 0 && bytes + size > config.daily_bytes) {
    return {
      ok: false,
      response: apiError(
        429,
        "daily_limit",
        `This network can send ${Math.floor(config.daily_bytes / (1024 * 1024))} MB per day to this Ferry.`,
      ),
    };
  }

  return { ok: true, config, day, hash };
}

export async function consumePublicQuota(env, day, hash, size) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO send_quota (ip_hash, day, files, bytes) VALUES (?, ?, 1, ?)
       ON CONFLICT(ip_hash, day) DO UPDATE SET
         files = send_quota.files + 1,
         bytes = send_quota.bytes + excluded.bytes`,
    ).bind(hash, day, size, size),
    env.DB.prepare("DELETE FROM send_quota WHERE day < ?").bind(day - 7),
  ]);
}

export function validId(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}

// Strip path components, control characters, bidi overrides, zero-width
// characters, and Windows-trailing dots/spaces. The name is only displayed and
// used in Content-Disposition, never used as a filesystem path in the cloud.
export function cleanName(raw) {
  const text = typeof raw === "string" ? raw : "";
  const base = text.split(/[\\/]/).pop() || "";
  const filtered = Array.from(base.normalize("NFC"))
    .filter((character) => !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(character))
    .join("")
    .trim()
    .replace(/[. ]+$/g, "");
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
