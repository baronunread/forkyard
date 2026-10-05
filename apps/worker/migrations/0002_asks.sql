-- Requests for a person: agents blocked on a question, or autopilot handing over a decision.
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  yard_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS asks_yard_status ON asks (yard_id, status, created_at);
CREATE INDEX IF NOT EXISTS asks_task ON asks (yard_id, task_id, status);
