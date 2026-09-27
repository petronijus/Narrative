-- Agentic layer A1 (docs/plans/agentic-layer.md §4.5, ADR 0011): OAuth 2.1 for
-- MCP clients that cannot take a personal access token (claude.ai custom
-- connectors). Narrative is the authorization server; the sign-in step is the
-- existing Google sign-in session. See apps/server/src/mcp/oauth/ and docs/mcp.md.
--
-- mcp_oauth_clients         dynamically registered clients (RFC 7591). Redirect
--                           URIs are restricted to claude.ai callbacks and loopback.
-- mcp_oauth_authorizations  one authorization request: its validated parameters,
--                           the consent decision and the one-time code. `csrf_hash`
--                           guards the consent form; `code_hash` is set on approval;
--                           `exchanged_at` makes the code single-use, and a reused
--                           code revokes the grant it produced (`grant_id`).
-- mcp_oauth_grants          a user's approval of one client ("connection"): what the
--                           tokens act as. Revoking it revokes every token of it.
-- mcp_oauth_tokens          access (1 h) and refresh (30 d, rotated on every use)
--                           tokens. Only SHA-256 hashes of codes, tokens and client
--                           secrets are stored.

CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id" text PRIMARY KEY,
  "client_name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "token_endpoint_auth_method" text NOT NULL,
  "client_secret_hash" text,
  "client_uri" text,
  "software_id" text,
  "software_version" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_grants" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "user_sub" text NOT NULL,
  "scopes" text[] NOT NULL,
  "resource" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_user_sub_idx" ON "mcp_oauth_grants" ("user_sub");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_authorizations" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "scopes" text[] NOT NULL,
  "resource" text NOT NULL,
  "state" text,
  "csrf_hash" text NOT NULL,
  "user_sub" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "decided_at" timestamptz,
  "decision" text,
  "code_hash" text,
  "code_expires_at" timestamptz,
  "exchanged_at" timestamptz,
  "grant_id" text REFERENCES "mcp_oauth_grants"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_authorizations_code_hash_idx" ON "mcp_oauth_authorizations" ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_authorizations_expires_at_idx" ON "mcp_oauth_authorizations" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_oauth_tokens" (
  "token_hash" text PRIMARY KEY,
  "grant_id" text NOT NULL REFERENCES "mcp_oauth_grants"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_grant_id_idx" ON "mcp_oauth_tokens" ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_tokens_expires_at_idx" ON "mcp_oauth_tokens" ("expires_at");
