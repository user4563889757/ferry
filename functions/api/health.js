import { json, nowSeconds } from "../lib/http.js";

export async function onRequestGet() {
  return json({ ok: true, version: "0.2.0-cloud", server_time: nowSeconds() });
}
