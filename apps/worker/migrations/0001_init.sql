-- Forkyard durable records. Live state (claims, overlaps, event log, sockets)
-- lives in the per-yard Durable Object; D1 holds what humans and agents query
-- across yards and what must outlive a DO.

CREATE TABLE yards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_repo TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'default',
  preview_url_template TEXT,
  budgets TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  yard_id TEXT NOT NULL REFERENCES yards(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (yard_id, id)
);
CREATE INDEX tasks_status ON tasks (status, decided_at);

CREATE TABLE agents (
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  harness TEXT NOT NULL,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  initials TEXT NOT NULL,
  status TEXT NOT NULL,
  fork_name TEXT NOT NULL UNIQUE,
  fork_remote TEXT,
  head_commit TEXT,
  fork_ms REAL,
  created_at TEXT NOT NULL,
  fork_deleted_at TEXT,
  PRIMARY KEY (yard_id, task_id, id)
);
CREATE INDEX agents_live ON agents (fork_deleted_at);

CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT NOT NULL,
  details TEXT,
  commit_hash TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX intents_agent ON intents (yard_id, task_id, agent_id, created_at);

CREATE TABLE diffs (
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (yard_id, task_id, agent_id, commit_hash)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  score REAL NOT NULL,
  summary TEXT NOT NULL,
  checks TEXT NOT NULL,
  comments TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX reviews_agent ON reviews (yard_id, task_id, agent_id, created_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  winner_agent_id TEXT,
  selections TEXT NOT NULL,
  result_commit TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE bench_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  stats TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- People sign in with GitHub or Google; yards belong to their members.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE accounts (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX accounts_user ON accounts (user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE yard_members (
  yard_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (yard_id, user_id)
);
CREATE INDEX yard_members_user ON yard_members (user_id);
