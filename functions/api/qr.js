import qrcode from "qrcode-generator";
import { apiError } from "../lib/http.js";

export async function onRequestGet({ request }) {
  const text = new URL(request.url).searchParams.get("text") || "";
  if (!text || text.length > 2048) {
    return apiError(400, "invalid_text", "QR text must be between 1 and 2048 characters.");
  }

  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 4 });

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "no-store",
    },
  });
}
