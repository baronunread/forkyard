-- The GitHub repo whose issues are being imported into this yard's backlog, while it runs.
ALTER TABLE yards ADD COLUMN importing_issues TEXT;
