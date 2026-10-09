-- Yards live at /owner/slug. A person's handle is their GitHub login (or email name),
-- picked once; yards made by the operator's scripts belong to "forkyard".
CREATE TABLE handles (
  user_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE
);

ALTER TABLE yards ADD COLUMN owner TEXT NOT NULL DEFAULT 'forkyard';
ALTER TABLE yards ADD COLUMN slug TEXT;
UPDATE yards SET slug = id;
CREATE UNIQUE INDEX yards_owner_slug ON yards (owner, slug);
