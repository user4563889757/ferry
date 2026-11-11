-- Migration for databases created before public sending existed.
-- Run once:
--   npx wrangler d1 execute ferry --remote --file=migrations/0002_public_send.sql
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so this file is intentionally not
-- idempotent. A fresh database should use schema.sql instead.

ALTER TABLE files ADD COLUMN visibility TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE files ADD COLUMN upload_token_hash TEXT;
ALTER TABLE files ADD COLUMN expires_at INTEGER;
ALTER TABLE files ADD COLUMN sender_hash TEXT;

CREATE INDEX IF NOT EXISTS files_expires ON files (expires_at);
CREATE INDEX IF NOT EXISTS files_upload_token ON files (upload_token_hash);

CREATE TABLE IF NOT EXISTS send_quota (
  ip_hash TEXT NOT NULL,
  day INTEGER NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
