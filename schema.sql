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
  fingerprint TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS files_fingerprint ON files (fingerprint);
CREATE INDEX IF NOT EXISTS files_created ON files (created_at DESC);

CREATE TABLE IF NOT EXISTS chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);
