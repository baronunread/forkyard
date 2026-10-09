-- A one-agent task is reviewed only when asked; two or more agents always are.
ALTER TABLE tasks ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
