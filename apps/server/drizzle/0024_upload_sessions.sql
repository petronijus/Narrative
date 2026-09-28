-- Agentic A2.7a (2026-09-28): one-time upload sessions for agents.
--
-- `media.uploadSession` lets an agent with a shell (Claude Code) send a local
-- file through the tus upload the editor uses, with curl, instead of writing
-- its bytes out as base64 through the model. Each row is one credential:
-- the raw token (`nus_…`) is shown once and only its SHA-256 is stored; it
-- expires after a few minutes, uploads media (image, video, font) into one
-- deck only, and is bound to the first upload it creates (`upload_id`), which
-- it may then only continue. Rows go with their deck; expired rows are swept
-- when new sessions are issued.

CREATE TABLE IF NOT EXISTS "upload_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "user_sub" text NOT NULL,
  "deck_id" text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "upload_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "upload_sessions_token_hash_idx" ON "upload_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "upload_sessions_expires_at_idx" ON "upload_sessions" ("expires_at");
