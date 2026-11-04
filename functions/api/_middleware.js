import { apiError } from "../lib/http.js";

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function onRequest(context) {
  const expected = context.env.FERRY_KEY;
  if (!expected) {
    return apiError(500, "not_configured", "The share key is not configured.");
  }

  const url = new URL(context.request.url);
  const supplied =
    context.request.headers.get("x-ferry-key") || url.searchParams.get("key") || "";

  const publicRoute = url.pathname === "/api/health";
  if (!publicRoute && !constantTimeEqual(supplied, expected)) {
    return apiError(401, "unauthorized", "A valid share key is required.", {
      "www-authenticate": "Ferry",
    });
  }

  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "geolocation=(), microphone=(), camera=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
