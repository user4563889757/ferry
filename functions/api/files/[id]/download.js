import { CHUNK, apiError, getMeta } from "../../../lib/http.js";

function parseRange(value, size) {
  if (!value || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) throw new Error("invalid range");

  const [, startText, endText] = match;
  if (!startText && !endText) throw new Error("invalid range");

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("invalid range");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
    throw new Error("invalid range");
  }

  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (!Number.isSafeInteger(end) || end < start) throw new Error("invalid range");
  return { start, end };
}

function contentDisposition(name) {
  const fallback = Array.from(name)
    .map((character) =>
      /[\x20-\x7e]/.test(character) && character !== '"' && character !== "\\"
        ? character
        : "_",
    )
    .join("") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function onRequestGet(context) {
  const { env, params, request } = context;
  const meta = await getMeta(env, params.id);
  if (!meta) return apiError(404, "not_found", "File not found.");
  if (meta.status !== "complete") {
    return apiError(400, "still_uploading", "File is still uploading.");
  }

  let requested = null;
  try {
    requested = parseRange(request.headers.get("range"), meta.size);
  } catch {
    return apiError(
      416,
      "range_not_satisfiable",
      "The requested byte range is not available.",
      { size: meta.size, "content-range": `bytes */${meta.size}` },
    );
  }

  const status = requested ? 206 : 200;
  const start = requested ? requested.start : 0;
  const end = requested ? requested.end : Math.max(0, meta.size - 1);
  const length = meta.size === 0 ? 0 : end - start + 1;

  let current = start;
  let finished = meta.size === 0;
  const lastIndex = Math.floor(end / CHUNK);
  const cache = new Map();
  const BATCH = 8;
  const stream = new ReadableStream({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      if (current > end) {
        finished = true;
        controller.close();
        return;
      }

      const index = Math.floor(current / CHUNK);
      if (!cache.has(index)) {
        const last = Math.min(lastIndex, index + BATCH - 1);
        const { results } = await env.DB.prepare(
          "SELECT idx, data FROM chunks WHERE file_id = ? AND idx >= ? AND idx <= ? ORDER BY idx",
        )
          .bind(meta.id, index, last)
          .all();
        cache.clear();
        for (const row of results || []) {
          cache.set(Number(row.idx), new Uint8Array(row.data));
        }
      }

      const bytes = cache.get(index);
      if (!bytes) {
        controller.error(new Error("missing chunk"));
        return;
      }

      const chunkStart = index * CHUNK;
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(bytes.length, end - chunkStart + 1);
      if (to <= from) {
        finished = true;
        controller.close();
        return;
      }

      controller.enqueue(bytes.subarray(from, to));
      current = chunkStart + to;
      if (current > end) {
        finished = true;
        controller.close();
      }
    },
  });

  const headers = new Headers({
    "content-type": meta.mime || "application/octet-stream",
    "content-length": String(length),
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-disposition": contentDisposition(meta.name),
    etag: `"${meta.id}-${meta.size}"`,
  });
  if (status === 206) {
    headers.set("content-range", `bytes ${start}-${end}/${meta.size}`);
  }

  return new Response(stream, { status, headers });
}
