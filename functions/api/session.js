import {
  clearFailures,
  clearedSessionCookie,
  createSession,
  recordFailure,
  sessionCookie,
  verifyKey,
} from "../lib/auth.js";
import { apiError } from "../lib/http.js";

export async function onRequestPost({ request, env }) {
  if (!env.FERRY_KEY) {
    return apiError(500, "not_configured", "The share key is not configured.");
  }

  const supplied = request.headers.get("x-ferry-key") || "";
  if (!(await verifyKey(supplied, env.FERRY_KEY))) {
    recordFailure(request);
    return apiError(401, "unauthorized", "That share key is not valid.", {
      "www-authenticate": "Ferry",
    });
  }

  clearFailures(request);
  const session = await createSession(env);
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": sessionCookie(session.token, session.maxAge),
      "cache-control": "no-store",
    },
  });
}

export async function onRequestDelete() {
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": clearedSessionCookie(),
      "cache-control": "no-store",
    },
  });
}
