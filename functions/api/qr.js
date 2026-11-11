import qrcode from "qrcode-generator";
import { apiError } from "../lib/http.js";

export async function onRequestPost({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return apiError(400, "invalid_json", "The QR request is not valid JSON.");
  }

  const text = body && typeof body.text === "string" ? body.text : "";
  if (!text || text.length > 2048) {
    return apiError(400, "invalid_text", "QR text must be between 1 and 2048 characters.");
  }

  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 4 });

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "content-disposition": 'inline; filename="ferry-qr.svg"',
      "content-security-policy": "default-src 'none'; style-src 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
