import {
  CHUNK,
  MAX_DB,
  MAX_FILE,
  json,
  nowSeconds,
  publicConfig,
} from "../lib/http.js";

export async function onRequestGet({ env }) {
  const config = publicConfig(env);
  return json({
    mode: "cloud",
    public_send: config.enabled,
    max_public_file: config.max_file,
    public_expiry_hours: config.expiry_hours,
    public_daily_files: config.daily_files,
    public_daily_bytes: config.daily_bytes,
    max_file: MAX_FILE,
    max_chunk: CHUNK,
    capacity: MAX_DB,
    server_time: nowSeconds(),
  });
}
