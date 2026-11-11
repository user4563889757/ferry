CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  offset INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  modified_at INTEGER,
  fingerprint TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'owner',
  upload_token_hash TEXT,
  expires_at INTEGER,
  sender_hash TEXT
);

CREATE INDEX IF NOT EXISTS files_fingerprint ON files (fingerprint);
CREATE INDEX IF NOT EXISTS files_created ON files (created_at DESC);
CREATE INDEX IF NOT EXISTS files_expires ON files (expires_at);
CREATE INDEX IF NOT EXISTS files_upload_token ON files (upload_token_hash);

CREATE TABLE IF NOT EXISTS chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- Per-network daily limits for public sends. The address is hashed with
-- FERRY_KEY as a pepper; raw IP addresses are never stored.
CREATE TABLE IF NOT EXISTS send_quota (
  ip_hash TEXT NOT NULL,
  day INTEGER NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, day)
);
