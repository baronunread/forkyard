-- The model a person's reviews use on their ChatGPT plan (null: the same as their agents').
ALTER TABLE model_credentials ADD COLUMN review_model TEXT;
