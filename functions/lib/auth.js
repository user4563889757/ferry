// Authentication and abuse-control helpers for the Cloudflare backend.
//
// The share key is never accepted in a query string. It is either:
//   - sent as X-Ferry-Key by API clients, or
//   - exchanged once for a signed, HttpOnly, SameSite=Strict cookie.
//
// The cookie contains no secret: it is an expiry, a random nonce, and an
// HMAC-SHA256 signature made with FERRY_KEY.

export const SESSION_COOKIE = "__Host-ferry_session";
export const SESSION_TTL = 12 * 60 * 60;

const encoder = new TextEncoder();
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;
const MAX_TRACKED_CLIENTS = 5000;
const failures = new Map();

let cachedSecret = "";
let cachedKey = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const text = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Hash both values first so the comparison is fixed-length even when the
// supplied key has the wrong length.
export async function verifyKey(supplied, expected) {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof supplied !== "string") return false;
  const [left, right] = await Promise.all([sha256(supplied), sha256(expected)]);
  return equalBytes(left, right);
}

async function hmacKey(secret) {
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedSecret = secret;
  return cachedKey;
}

async function sign(secret, data) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

export async function createSession(env) {
  const expires = nowSeconds() + SESSION_TTL;
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `v1.${expires}.${nonce}`;
  const signature = base64url(await sign(env.FERRY_KEY, payload));
  return { token: `${payload}.${signature}`, maxAge: SESSION_TTL };
}

export async function verifySession(env, token) {
  if (typeof token !== "string" || typeof env.FERRY_KEY !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(expires)) return false;
  const now = nowSeconds();
  if (expires <= now || expires > now + SESSION_TTL + 300) return false;
  const payload = `v1.${expires}.${parts[2]}`;
  let supplied;
  try {
    supplied = fromBase64url(parts[3]);
  } catch {
    return false;
  }
  const expected = await sign(env.FERRY_KEY, payload);
  return equalBytes(supplied, expected);
}

export function readCookie(request, name = SESSION_COOKIE) {
  const header = request.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export async function isAuthorized(request, env) {
  const supplied = request.headers.get("x-ferry-key");
  if (supplied) return verifyKey(supplied, env.FERRY_KEY);
  const token = readCookie(request);
  if (token) return verifySession(env, token);
  return false;
}

// SameSite=Lax is deliberate. A Strict cookie is withheld when someone opens
// the site from a link in another app (WhatsApp, SMS, a QR scanner), which made
// phones look logged out. Lax still blocks cross-site POSTs, and the middleware
// additionally checks Origin and Sec-Fetch-Site for every state change.
export function sessionCookie(token, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function isUnsafeMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

// SameSite=Lax already blocks cross-site state-changing requests. This is
// defence in depth for clients that ignore SameSite, and it also covers the
// login endpoint.
export function originAllowed(request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;

  let expected;
  try {
    expected = new URL(request.url).origin;
  } catch {
    return false;
  }
  return origin === expected;
}

function clientKey(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function prune(now) {
  if (failures.size <= MAX_TRACKED_CLIENTS) return;
  for (const [key, hits] of failures) {
    const live = hits.filter((time) => now - time < FAILURE_WINDOW_MS);
    if (live.length === 0) failures.delete(key);
    else failures.set(key, live);
    if (failures.size <= MAX_TRACKED_CLIENTS / 2) break;
  }
}

export function retryAfter(request) {
  const now = Date.now();
  prune(now);
  const hits = failures.get(clientKey(request));
  if (!hits) return 0;
  const live = hits.filter((time) => now - time < FAILURE_WINDOW_MS);
  if (live.length === 0) {
    failures.delete(clientKey(request));
    return 0;
  }
  failures.set(clientKey(request), live);
  if (live.length < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((live[0] + FAILURE_WINDOW_MS - now) / 1000));
}

export function recordFailure(request) {
  const now = Date.now();
  const key = clientKey(request);
  const hits = (failures.get(key) || []).filter((time) => now - time < FAILURE_WINDOW_MS);
  hits.push(now);
  failures.set(key, hits.slice(-MAX_FAILURES));
  prune(now);
}

export function clearFailures(request) {
  failures.delete(clientKey(request));
}
