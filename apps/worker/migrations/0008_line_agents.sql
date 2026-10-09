-- Which agent wrote each line of a file assembled from several agents' hunks, saved when the
-- decision lands (the forks are cleaned up later). Lines are 0-based in the decision commit's
-- version of the file; null for lines that were already there.
CREATE TABLE line_agents (
  yard_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  agents TEXT NOT NULL,
  PRIMARY KEY (yard_id, commit_hash, path)
);
