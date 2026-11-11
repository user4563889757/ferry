import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_DB,
  cleanName,
  constantTimeEqual,
  hashUploadToken,
  normalizeMime,
  publicConfig,
  publicMeta,
  validId,
  validUploadToken,
} from "../functions/lib/http.js";
import { contentDisposition, parseRange } from "../functions/api/files/[id]/download.js";
import {
  createSession,
  readCookie,
  sessionCookie,
  verifyKey,
  verifySession,
} from "../functions/lib/auth.js";

test("cleanName removes paths, control characters, bidi, and trailing dots", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("a\u0000b\u202ec.txt"), "abc.txt");
  assert.equal(cleanName("report.txt... "), "report.txt");
  assert.equal(cleanName("   "), "unnamed-file");
  assert.ok(cleanName("x".repeat(500)).length <= 200);
});

test("normalizeMime only accepts a real MIME shape", () => {
  assert.equal(normalizeMime("text/html", "x.bin"), "text/html");
  assert.equal(normalizeMime("not a mime", "photo.PNG"), "image/png");
  assert.equal(normalizeMime("", "unknown.bin"), "application/octet-stream");
});

test("validId accepts only 32 lowercase hex characters", () => {
  assert.equal(validId("a".repeat(32)), true);
  assert.equal(validId("A".repeat(32)), false);
  assert.equal(validId("../meta"), false);
  assert.equal(validId("a".repeat(31)), false);
});

test("parseRange handles normal, open, suffix, and invalid ranges", () => {
  assert.deepEqual(parseRange("bytes=0-4", 10), { start: 0, end: 4 });
  assert.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.equal(parseRange(null, 10), null);
  assert.throws(() => parseRange("bytes=10-", 10));
  assert.throws(() => parseRange("bytes=3-1", 10));
  assert.throws(() => parseRange("bytes=0-1,4-5", 10));
  assert.throws(() => parseRange("bytes=-0", 10));
});

test("contentDisposition is always an attachment", () => {
  const header = contentDisposition('résumé "final".pdf');
  assert.match(header, /^attachment; filename="/);
  assert.match(header, /filename\*=UTF-8''/);
  assert.doesNotMatch(header, /[\r\n]/);
});

test("keys are compared without leaking a length shortcut", async () => {
  assert.equal(await verifyKey("correct-horse", "correct-horse"), true);
  assert.equal(await verifyKey("correct-horse", "correct-horsf"), false);
  assert.equal(await verifyKey("short", "a-much-longer-key"), false);
  assert.equal(await verifyKey("", ""), false);
});

test("session tokens are signed, expiring, and not reusable after tampering", async () => {
  const env = { FERRY_KEY: "a-long-test-share-key" };
  const session = await createSession(env);
  assert.equal(await verifySession(env, session.token), true);
  assert.equal(await verifySession({ FERRY_KEY: "another-key" }, session.token), false);
  assert.equal(await verifySession(env, `${session.token}x`), false);
  assert.equal(await verifySession(env, "v1.1.2.3"), false);
  assert.match(sessionCookie(session.token), /HttpOnly/);
  assert.match(sessionCookie(session.token), /SameSite=Lax/);
  assert.match(sessionCookie(session.token), /Secure/);
});

test("public send limits are bounded and configurable", () => {
  const off = publicConfig({});
  assert.equal(off.enabled, false);
  assert.ok(off.max_file <= 350 * 1024 * 1024);

  const on = publicConfig({
    PUBLIC_SEND: "1",
    PUBLIC_MAX_MB: "50",
    PUBLIC_EXPIRY_HOURS: "24",
    PUBLIC_DAILY_FILES: "20",
    PUBLIC_DAILY_MB: "200",
    PUBLIC_BUDGET_MB: "300",
  });
  assert.equal(on.enabled, true);
  assert.equal(on.max_file, 50 * 1024 * 1024);
  assert.equal(on.expiry_hours, 24);
  assert.equal(on.daily_files, 20);
  assert.equal(on.daily_bytes, 200 * 1024 * 1024);
  assert.equal(on.budget, 300 * 1024 * 1024);
  assert.ok(on.budget <= MAX_DB);

  const absurd = publicConfig({
    PUBLIC_SEND: "1",
    PUBLIC_MAX_MB: "99999",
    PUBLIC_EXPIRY_HOURS: "99999",
    PUBLIC_BUDGET_MB: "99999",
  });
  assert.ok(absurd.max_file <= MAX_DB);
  assert.ok(absurd.expiry_hours <= 24 * 30);
  assert.ok(absurd.budget <= MAX_DB);
});

test("public metadata never leaks capability or sender hashes", () => {
  const row = {
    id: "a".repeat(32),
    name: "photo.jpg",
    size: 10,
    offset: 4,
    visibility: "public",
    expires_at: 123,
    upload_token_hash: "deadbeef",
    sender_hash: "cafebabe",
  };
  const safe = publicMeta(row);
  assert.equal(safe.id, row.id);
  assert.equal(safe.visibility, "public");
  assert.equal("upload_token_hash" in safe, false);
  assert.equal("sender_hash" in safe, false);
  assert.equal(publicMeta(null), null);
});

test("upload tokens are high-entropy and only hashed for storage", async () => {
  assert.equal(validUploadToken("short"), false);
  assert.equal(validUploadToken("a".repeat(32)), true);
  assert.equal(validUploadToken("a".repeat(31)), false);
  assert.equal(validUploadToken("a".repeat(65)), false);
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  const hash = await hashUploadToken("a".repeat(32));
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("cookies are parsed without matching similar names", () => {
  const request = new Request("https://example.test/", {
    headers: { cookie: "other=1; __Host-ferry_session=abc; another=2" },
  });
  assert.equal(readCookie(request), "abc");
});
