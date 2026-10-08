-- A person's own model subscription (today: ChatGPT via the Codex sign-in), used for
-- reviews in the yards they own. The credential is AES-GCM encrypted at rest.
CREATE TABLE IF NOT EXISTS model_credentials (
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  credential TEXT NOT NULL,
  label TEXT,
  use_for_reviews INTEGER NOT NULL DEFAULT 1,
  -- A refresh in progress (epoch ms): concurrent reviews wait instead of racing a rotating refresh token.
  refreshing_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);

-- A device-code sign-in someone has started and not finished yet.
CREATE TABLE IF NOT EXISTS model_device_logins (
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  device_auth_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  interval_s INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);
