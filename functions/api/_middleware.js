import {
  clearFailures,
  isAuthorized,
  isUnsafeMethod,
  originAllowed,
  recordFailure,
  retryAfter,
} from "../lib/auth.js";
import { apiError } from "../lib/http.js";

const PUBLIC_EXACT = new Set(["/api/health", "/api/config", "/api/session"]);
const PUBLIC_UPLOAD = /^\/api\/uploads\/[a-f0-9]{32}$/;

function isPublicRoute(method, pathname) {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname === "/api/uploads" && method === "POST") return true;
  if (PUBLIC_UPLOAD.test(pathname) && ["GET", "PUT"].includes(method)) return true;
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.FERRY_KEY) {
    return apiError(500, "not_configured", "The share key is not configured.");
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const publicRoute = isPublicRoute(method, url.pathname);

  if (isUnsafeMethod(request.method) && !originAllowed(request)) {
    return apiError(403, "cross_origin", "Cross-origin state changes are not allowed.");
  }

  // Public sends have their own daily quotas. Do not let failed owner logins
  // from a shared network block anonymous senders.
  const sensitive = !publicRoute || url.pathname === "/api/session";
  if (sensitive) {
    const retry = retryAfter(request);
    if (retry > 0) {
      return apiError(429, "rate_limited", "Too many failed attempts. Try again later.", {
        "retry-after": String(retry),
      });
    }
  }

  const authorized = await isAuthorized(request, env);
  context.data.owner = authorized;

  if (!publicRoute && !authorized) {
    recordFailure(request);
    return apiError(401, "unauthorized", "A valid share key is required.", {
      "www-authenticate": "Ferry",
    });
  }

  if (authorized) clearFailures(request);

  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "geolocation=(), microphone=(), camera=(), usb=(), serial=(), payment=()",
  );
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("x-permitted-cross-domain-policies", "none");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("strict-transport-security", "max-age=31536000");
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  }
  headers.set("cache-control", headers.get("cache-control") || "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
