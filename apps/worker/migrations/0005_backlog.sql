-- Backlog: tasks that haven't started (issue #15). Starting one creates a task and links it here;
-- when that task is decided, the item is done.
CREATE TABLE IF NOT EXISTS backlog_items (
  yard_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL,
  -- 'forkyard' or 'github'; source_ref is e.g. 'owner/repo#12', kept for reference only.
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | started | done | dropped
  task_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (yard_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS backlog_source ON backlog_items (yard_id, source_ref);
CREATE INDEX IF NOT EXISTS backlog_task ON backlog_items (yard_id, task_id);

CREATE TABLE IF NOT EXISTS backlog_comments (
  yard_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS backlog_comments_item ON backlog_comments (yard_id, item_id, created_at);
