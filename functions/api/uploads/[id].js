import {
  CHUNK,
  MAX_DB,
  MAX_FILE,
  apiError,
  conflict,
  getMeta,
  json,
  nowSeconds,
  storedBytes,
  validId,
} from "../../lib/http.js";

export async function onRequestPut({ request, env, params }) {
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
  if (meta.status === "complete") return conflict(meta.offset);
  if (offset !== meta.offset) return conflict(meta.offset);

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

  return json({
    ...meta,
    offset: nextOffset,
    status,
    updated_at: now,
  });
}
