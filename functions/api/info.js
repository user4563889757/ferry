import { CHUNK, MAX_DB, MAX_FILE, json, nowSeconds } from "../lib/http.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}/`;
  return json({
    device_name: env.FERRY_NAME || "Ferry Cloud",
    version: "0.2.0-cloud",
    mode: "cloud",
    started_at: 0,
    server_time: nowSeconds(),
    max_chunk: CHUNK,
    max_file: MAX_FILE,
    capacity: MAX_DB,
    interfaces: [
      {
        name: "public",
        address: url.host,
        url: origin,
        bluetooth: false,
      },
    ],
  });
}
