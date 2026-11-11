import {
  CHUNK,
  MAX_DB,
  MAX_FILE,
  apiError,
  conflict,
  constantTimeEqual,
  getMeta,
  hashUploadToken,
  json,
  nowSeconds,
  publicConfig,
  publicMeta,
  storedBytes,
  storedBytesBy,
  validId,
  validUploadToken,
} from "../../lib/http.js";

async function authorizeUpload(request, env, meta, owner) {
  if (owner) return null;
  if (meta.visibility !== "public") {
    return apiError(403, "forbidden", "This upload is not open to public appends.");
  }
  if (meta.expires_at && Number(meta.expires_at) <= nowSeconds()) {
    return apiError(410, "expired", "This public upload has expired.");
  }
  const token = request.headers.get("x-ferry-upload") || "";
  if (!validUploadToken(token) || !meta.upload_token_hash) {
    return apiError(403, "upload_token_required", "A valid upload token is required.");
  }
  const supplied = await hashUploadToken(token);
  if (!constantTimeEqual(supplied, meta.upload_token_hash)) {
    return apiError(403, "upload_token_required", "A valid upload token is required.");
  }
  return null;
}

export async function onRequestGet({ request, env, params, data }) {
  if (!validId(params.id)) {
    return apiError(404, "not_found", "File not found.");
  }
  const meta = await getMeta(env, params.id);
  if (!meta) return apiError(404, "not_found", "File not found.");

  const denied = await authorizeUpload(request, env, meta, Boolean(data?.owner));
  if (denied) return denied;

  return json({
    id: meta.id,
    name: meta.name,
    size: meta.size,
    offset: meta.offset,
    status: meta.status,
    expires_at: meta.expires_at,
  });
}

export async function onRequestPut({ request, env, params, data }) {
  if (!validId(params.id)) {
    return apiError(404, "not_found", "File not found.");
  }

  const url = new URL(request.url);
  const offset = Number(url.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return apiError(400, "invalid_offset", "The upload offset is invalid.");
  }
  if (offset % CHUNK !== 0) {
    return apiError(400, "invalid_offset", "Upload chunks must be aligned to 1 MB.");
  }

  const meta = await getMeta(env, params.id);
  if (!meta) return apiError(404, "not_found", "File not found.");

  const owner = Boolean(data?.owner);
  const denied = await authorizeUpload(request, env, meta, owner);
  if (denied) return denied;

  if (meta.status === "complete") return conflict(meta.offset);
  if (offset !== meta.offset) return conflict(meta.offset);

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > CHUNK)) {
    return apiError(400, "chunk_too_large", "The upload chunk is too large.");
  }

  const buffer = await request.arrayBuffer();
  const length = buffer.byteLength;
  if (length === 0) {
    return apiError(400, "empty_chunk", "The upload chunk is empty.");
  }
  if (length > CHUNK || length > MAX_FILE) {
    return apiError(400, "chunk_too_large", "The upload chunk is too large.");
  }
  if (length > meta.size - meta.offset) {
    return apiError(400, "chunk_too_large", "The upload chunk is larger than the remaining file.");
  }

  const used = await storedBytes(env);
  if (used + length > MAX_DB) {
    return apiError(
      507,
      "storage_full",
      "This Ferry is out of free storage. Delete a file before continuing.",
      { free: Math.max(0, MAX_DB - used), capacity: MAX_DB },
    );
  }
  if (!owner && meta.visibility === "public") {
    const config = publicConfig(env);
    const publicUsed = await storedBytesBy(env, "public");
    if (publicUsed + length > config.budget) {
      return apiError(
        507,
        "storage_full",
        "The public drop box is full. Ask the owner to clear space.",
        { free: Math.max(0, config.budget - publicUsed), capacity: config.budget },
      );
    }
  }

  const nextOffset = meta.offset + length;
  const status = nextOffset === meta.size ? "complete" : "uploading";
  const now = nowSeconds();
  const index = offset / CHUNK;

  const results = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO chunks (file_id, idx, data) VALUES (?, ?, ?)",
    ).bind(meta.id, index, buffer),
    env.DB.prepare(
      "UPDATE files SET offset = ?, status = ?, updated_at = ? WHERE id = ? AND offset = ?",
    ).bind(nextOffset, status, now, meta.id, offset),
  ]);

  const changed = results[1]?.meta?.changes || 0;
  if (changed === 0) {
    const current = await getMeta(env, meta.id);
    return conflict(current ? current.offset : meta.offset);
  }

  return json(
    publicMeta({
      ...meta,
      offset: nextOffset,
      status,
      updated_at: now,
    }),
  );
}
