-- Agentic layer A1 (docs/plans/agentic-layer.md §4.3, §6; ADR 0011).
--
-- personal_access_tokens: a second identity next to the session cookie, for
--   Claude Code over MCP and for scripts using the batch API. Only the
--   SHA-256 of the token is stored; `prefix` is the first characters of the
--   raw token so a user can recognise it in the list.
-- agent_runs / agent_ops: every agent write is attributed to a run (one MCP
--   session's work on one deck), and every command of a run is logged — the
--   audit trail and the basis of per-run revert.

CREATE TABLE IF NOT EXISTS "personal_access_tokens" (
  "id" text PRIMARY KEY,
  "user_sub" text NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "expires_at" timestamptz,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personal_access_tokens_token_hash_idx" ON "personal_access_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personal_access_tokens_user_sub_idx" ON "personal_access_tokens" ("user_sub");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" text PRIMARY KEY,
  "user_sub" text NOT NULL,
  "deck_id" text REFERENCES "decks"("id") ON DELETE CASCADE,
  "surface" text NOT NULL,
  "client_name" text,
  "request" text,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_activity_at" timestamptz NOT NULL DEFAULT now(),
  "closed_at" timestamptz,
  "reverted_at" timestamptz,
  "reverted_by_sub" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_deck_id_idx" ON "agent_runs" ("deck_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_user_sub_idx" ON "agent_runs" ("user_sub", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_ops" (
  "id" bigserial PRIMARY KEY,
  "run_id" text NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "command" text NOT NULL,
  "input" jsonb NOT NULL,
  "result" jsonb,
  "error" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_ops_run_seq_idx" ON "agent_ops" ("run_id", "seq");
