-- Daily counters behind the hard limits (src/limits.ts).
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);
