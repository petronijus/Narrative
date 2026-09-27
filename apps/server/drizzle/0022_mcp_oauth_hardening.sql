-- Agentic layer A1: hardening of the MCP OAuth authorization server after the
-- security review of the MCP surface (2026-09-27). apps/server/src/mcp/oauth/,
-- docs/mcp.md.
--
-- 1. Registered scopes and grant types are stored and enforced.
--      mcp_oauth_clients.scopes / grant_types
--          what a dynamically registered client asked for (RFC 7591: an absent
--          grant_types means `authorization_code` only; an absent scope means
--          every supported scope). /authorize intersects the requested scopes
--          with the registered ones, and drops `offline_access` unless the
--          client may use `refresh_token`. NULL on older registrations, which
--          keep today's behaviour (both scopes, both grant types).
--      mcp_oauth_authorizations.client_grant_types, mcp_oauth_grants.grant_types
--          snapshots of the client's grant types (registered or from its Client
--          ID Metadata Document) so the token endpoint decides whether to issue
--          and accept refresh tokens without refetching a document.
--
-- 2. mcp_oauth_authorizations.redirect_uri_provided — whether /authorize got an
--    explicit redirect_uri. When it did, the token request must repeat it exactly
--    (RFC 6749 §4.1.3). Defaults to true, so requests in flight during the deploy
--    are held to the stricter rule.
--
-- 3. Refresh-token replay detection.
--      mcp_oauth_tokens.used_by_fingerprint
--          SHA-256 of the rotating request's client IP and User-Agent, stored
--          when a refresh token is rotated. A replay inside the grace window
--          from the same fingerprint is the client racing itself (refused, the
--          grant kept); from another fingerprint it is not the first rotator,
--          and the grant is revoked.
--      mcp_oauth_grants.flagged_at / flag_reason
--          every replay flags the grant; the user sees it under Connected apps.
--
-- Retention (no schema change): the hourly maintenance now also deletes
-- authorizations decided or exchanged more than 30 days ago and grants revoked
-- more than 30 days ago (their tokens cascade).

ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "scopes" text[];
--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD COLUMN IF NOT EXISTS "grant_types" text[];
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "redirect_uri_provided" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_authorizations" ADD COLUMN IF NOT EXISTS "client_grant_types" text[];
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "grant_types" text[];
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "flagged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN IF NOT EXISTS "flag_reason" text;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_tokens" ADD COLUMN IF NOT EXISTS "used_by_fingerprint" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_oauth_grants_revoked_at_idx" ON "mcp_oauth_grants" ("revoked_at") WHERE "revoked_at" IS NOT NULL;
