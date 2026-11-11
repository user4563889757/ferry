import {
  MAX_DB,
  MAX_FILE,
  apiError,
  checkPublicQuota,
  cleanName,
  clientHash,
  consumePublicQuota,
  dayNumber,
  deleteExpired,
  findResume,
  hashUploadToken,
  json,
  newUploadToken,
  normalizeMime,
  nowSeconds,
  publicConfig,
  publicMeta,
  storedBytes,
  storedBytesBy,
  validUploadToken,
} from "../../lib/http.js";

export async function onRequestPost({ request, env, data }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "The upload request is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError(400, "invalid_json", "The upload request must be a JSON object.");
  }

  const owner = Boolean(data?.owner);
  const config = publicConfig(env);
  const name = cleanName(body.name);
  const size = Number(body.size);
  const limit = owner ? MAX_FILE : config.max_file;

  if (!Number.isSafeInteger(size) || size < 0) {
    return apiError(400, "invalid_size", "The file size is invalid.");
  }
  if (size > limit) {
    return apiError(
      400,
      "file_too_large",
      `Files are limited to ${Math.floor(limit / (1024 * 1024))} MB${owner ? "" : " for public sends"}.`,
    );
  }
  if (!owner && !config.enabled) {
    return apiError(403, "send_disabled", "Public sending is disabled on this Ferry.");
  }

  const fingerprint =
    typeof body.fingerprint === "string" && body.fingerprint.trim()
      ? body.fingerprint.trim().slice(0, 200)
      : `${name}:${size}:${body.modified_at || 0}`;

  if (!body.fresh) {
    if (owner) {
      const existing = await findResume(env, fingerprint);
      if (existing) return json(publicMeta(existing));
    } else if (validUploadToken(body.upload_token)) {
      // Public resumes need the capability token. A guessable fingerprint is
      // never enough to join someone else's in-flight upload.
      const existing = await env.DB.prepare(
        `SELECT * FROM files
         WHERE upload_token_hash = ? AND status = 'uploading'
           AND visibility = 'public' AND expires_at > ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
        .bind(await hashUploadToken(body.upload_token), nowSeconds())
        .first();
      if (existing && Number(existing.size) === size) {
        return json({ ...publicMeta(existing), upload_token: body.upload_token });
      }
    }
  }

  await deleteExpired(env);

  const used = await storedBytes(env);
  if (used + size > MAX_DB) {
    const free = Math.max(0, MAX_DB - used);
    return apiError(
      507,
      "storage_full",
      `This Ferry has ${Math.floor(free / (1024 * 1024))} MB free. Delete a file and try again.`,
      { free, capacity: MAX_DB },
    );
  }

  let quota = null;
  if (!owner) {
    quota = await checkPublicQuota(env, request, size);
    if (!quota.ok) return quota.response;

    const publicUsed = await storedBytesBy(env, "public");
    if (publicUsed + size > config.budget) {
      return apiError(
        507,
        "storage_full",
        "The public drop box is full. Ask the owner to clear space.",
        { free: Math.max(0, config.budget - publicUsed), capacity: config.budget },
      );
    }
  }

  const id = crypto.randomUUID().replaceAll("-", "");
  const now = nowSeconds();
  const status = size === 0 ? "complete" : "uploading";
  const modifiedAt = Number(body.modified_at);
  const uploadToken = owner ? null : newUploadToken();
  const meta = {
    id,
    name,
    size,
    offset: 0,
    mime: normalizeMime(body.mime, name),
    status,
    created_at: now,
    updated_at: now,
    modified_at:
      Number.isSafeInteger(modifiedAt) && modifiedAt >= 0
        ? Math.min(modifiedAt, 8640000000000000)
        : null,
    fingerprint,
    visibility: owner ? "owner" : "public",
    expires_at: owner ? null : now + config.expiry_hours * 3600,
    upload_token_hash: uploadToken ? await hashUploadToken(uploadToken) : null,
    sender_hash: owner ? null : await clientHash(request, env),
  };

  await env.DB.prepare(
    `INSERT INTO files
      (id, name, size, offset, mime, status, created_at, updated_at, modified_at,
       fingerprint, visibility, expires_at, upload_token_hash, sender_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      meta.id,
      meta.name,
      meta.size,
      meta.offset,
      meta.mime,
      meta.status,
      meta.created_at,
      meta.updated_at,
      meta.modified_at,
      meta.fingerprint,
      meta.visibility,
      meta.expires_at,
      meta.upload_token_hash,
      meta.sender_hash,
    )
    .run();

  if (!owner) {
    await consumePublicQuota(env, quota.day, quota.hash, size);
  }

  const response = publicMeta(meta);
  if (uploadToken) response.upload_token = uploadToken;
  return json(response);
}
