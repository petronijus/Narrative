-- Agentic A2.7a security review (2026-09-28): what an upload session is
-- bound to besides its deck and user.
--
--   credential_key  the credential that asked for it — `token:<pat id>` for a
--                   personal access token, `token:oauth:<grant id>` for an MCP
--                   OAuth connection (auth/agentSessions.ts keys) — so revoking
--                   that credential deletes the sessions it opened. NULL: a
--                   browser session.
--   size_bytes      the exact size of the one file it may upload (declared
--                   when it is issued, checked against the upload's length).
--   kind            image | video | font: the only kind it may upload.

ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "credential_key" text;
ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "size_bytes" integer;
ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "kind" text;
CREATE INDEX IF NOT EXISTS "upload_sessions_credential_key_idx" ON "upload_sessions" ("credential_key");
CREATE INDEX IF NOT EXISTS "upload_sessions_user_sub_idx" ON "upload_sessions" ("user_sub");
