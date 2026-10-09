-- The ChatGPT-plan model a person picked for their cloud agents and reviews (null: the default).
ALTER TABLE model_credentials ADD COLUMN model TEXT;
