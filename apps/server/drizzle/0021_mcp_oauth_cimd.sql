-- Agentic layer A1: Client ID Metadata Documents (CIMD) for the MCP OAuth
-- authorization server (apps/server/src/mcp/oauth/, docs/mcp.md).
--
-- A CIMD client's client_id is an https URL whose JSON document describes the
-- client (MCP authorization spec 2025-11-25). Such a client is resolved from its
-- document on each authorization (cached in memory within HTTP caching bounds)
-- and is NEVER stored as a registered client, so authorizations and grants can
-- now name their client in one of two ways, exactly one of them set:
--   client_id            a dynamically registered client (RFC 7591), FK as before
--   client_metadata_url  a CIMD client's client_id URL (no FK: there is no row)
--
-- Display snapshots (so a connection can be listed and a consent page shown
-- without resolving the client again, and without a row for CIMD clients):
--   mcp_oauth_authorizations.client_name / client_redirect_uris
--       the client's name and ALL its redirect URIs when the request was made
--       (the consent page warns when every one of them is a loopback address)
--   mcp_oauth_grants.client_name / redirect_uri
--       the client's name and the redirect URI the user approved
-- Grants made before this migration have NULL snapshots; the list falls back to
-- the registered client's row.
--
-- mcp_oauth_clients.last_used_at already exists; the hourly maintenance sweep
-- deletes registered clients without a live grant or pending authorization that
-- have been inactive for 7 days (claude.ai and other DCR clients register a new
-- client on every fresh connection). The cascade removes their revoked grants,
-- tokens and old authorizations with them.

ALTER TABLE "mcp_oauth_authorizations" ALTER COLUMN "client_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "client_metadata_url" text;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "client_redirect_uris" text[];
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_authorizations" ADD CONSTRAINT "mcp_oauth_authorizations_one_client_chk"
    CHECK (num_nonnulls("client_id", "client_metadata_url") = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ALTER COLUMN "client_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "client_metadata_url" text;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "redirect_uri" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_one_client_chk"
    CHECK (num_nonnulls("client_id", "client_metadata_url") = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_client_id_idx" ON "mcp_oauth_grants" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_authorizations_client_id_idx" ON "mcp_oauth_authorizations" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_clients_last_used_idx" ON "mcp_oauth_clients" (COALESCE("last_used_at", "created_at"));
