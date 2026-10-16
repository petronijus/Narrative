-- Which kinds of email Narrative sends (apps/server/src/email/catalog.ts),
-- switched by instance admins in the admin screen. No row = on.
CREATE TABLE IF NOT EXISTS "email_settings" (
  "kind" text PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL,
  "updated_by_sub" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
