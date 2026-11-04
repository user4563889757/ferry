import { apiError, getMeta, json } from "../../lib/http.js";

export async function onRequestGet({ env, params }) {
  const meta = await getMeta(env, params.id);
  if (!meta) return apiError(404, "not_found", "File not found.");
  return json(meta);
}

export async function onRequestDelete({ env, params }) {
  const meta = await getMeta(env, params.id);
  if (!meta) return apiError(404, "not_found", "File not found.");

  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE file_id = ?").bind(meta.id),
    env.DB.prepare("DELETE FROM files WHERE id = ?").bind(meta.id),
  ]);

  return new Response(null, { status: 204 });
}
