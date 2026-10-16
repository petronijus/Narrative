-- Instance admin (docs/adr/0014): an admin is owner of every folder and deck
-- except other people's Drafts, and manages who may sign in. The flag is on
-- the user; the allowlist the admin edits is its own table, next to the env
-- allowlist and the implicit invite / share grants.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "allowed_emails" (
  "email" text PRIMARY KEY NOT NULL,
  "added_by_sub" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL
);
