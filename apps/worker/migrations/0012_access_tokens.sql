-- A person's Forkyard access tokens: git signs in with one (kept by their credential helper).
-- Only the hash is stored; the token is shown once when it's made.
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX access_tokens_user ON access_tokens (user_id);
