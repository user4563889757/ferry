import { MAX_DB, MAX_FILE, json, nowSeconds } from "../../lib/http.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM files ORDER BY created_at DESC, name ASC LIMIT 100",
  ).all();
  const files = results || [];
  const complete = files.filter((file) => file.status === "complete");
  return json({
    files,
    stats: {
      count: complete.length,
      bytes: files.reduce((total, file) => total + Number(file.offset || 0), 0),
      uploading: files.filter((file) => file.status === "uploading").length,
      capacity: MAX_DB,
      max_file: MAX_FILE,
    },
    server_time: nowSeconds(),
  });
}
