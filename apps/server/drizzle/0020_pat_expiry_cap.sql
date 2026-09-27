-- Security review of agentic A1 (H3): personal access tokens must not outlive
-- the account-level kill switches.
--
-- personal_access_tokens.expires_at: every token now expires, at most 365 days
--   after creation ("never" is no longer a choice). Tokens created without an
--   expiry get created_at + 365 days — the longest lifetime a new token can
--   have — so a token older than a year stops working as soon as this runs.
--   The column becomes NOT NULL so a future code path cannot mint an
--   immortal token again.
-- users.email_verified: Google's `email_verified` claim at the last sign-in.
--   Every token verification re-applies the sign-in allowlist
--   (auth/signInPolicy.ts), whose OIDC_ALLOWED_DOMAIN rule requires a
--   verified email; without the stored claim that rule could not be checked
--   outside a sign-in. NULL (accounts that have not signed in since this
--   migration) counts as unverified, so a domain-only account's tokens start
--   working again at its next sign-in; accounts admitted by
--   OIDC_ALLOWED_EMAILS, an invite or a deck permission are unaffected.

UPDATE "personal_access_tokens"
SET "expires_at" = "created_at" + interval '365 days'
WHERE "expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ALTER COLUMN "expires_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean;
