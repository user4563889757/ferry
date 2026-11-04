import {
  MAX_DB,
  MAX_FILE,
  apiError,
  cleanName,
  findResume,
  json,
  normalizeMime,
  nowSeconds,
  storedBytes,
} from "../../lib/http.js";

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "The upload request is not valid JSON.");
  }

  const name = cleanName(body.name);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    return apiError(400, "invalid_size", "The file size is invalid.");
  }
  if (size > MAX_FILE) {
    return apiError(
      400,
      "file_too_large",
      `Files are limited to ${Math.floor(MAX_FILE / (1024 * 1024))} MB on this Ferry.`,
    );
  }

  const fingerprint =
    typeof body.fingerprint === "string" && body.fingerprint.trim()
      ? body.fingerprint.trim().slice(0, 200)
      : `${name}:${size}:${body.modified_at || 0}`;

  if (!body.fresh) {
    const existing = await findResume(env, fingerprint);
    if (existing) return json(existing);
  }

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

  const id = crypto.randomUUID().replaceAll("-", "");
  const now = nowSeconds();
  const status = size === 0 ? "complete" : "uploading";
  const meta = {
    id,
    name,
    size,
    offset: 0,
    mime: normalizeMime(body.mime, name),
    status,
    created_at: now,
    updated_at: now,
    modified_at: Number.isSafeInteger(Number(body.modified_at))
      ? Number(body.modified_at)
      : null,
    fingerprint,
  };

  await env.DB.prepare(
    `INSERT INTO files
      (id, name, size, offset, mime, status, created_at, updated_at, modified_at, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();

  return json(meta);
}
