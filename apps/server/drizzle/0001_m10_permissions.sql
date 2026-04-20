-- Migration: 0001_m10_permissions
-- M10 phase 1b: deck_permissions + share_links tables
-- Created: 2026-04-20
--
-- Adds per-deck role-based access control and public share link tokens.
--
-- Down (manual — drizzle-kit does not auto-generate rollbacks):
--   DROP TABLE IF EXISTS "share_links";
--   DROP TABLE IF EXISTS "deck_permissions";
--   DROP TYPE IF EXISTS "public"."deck_role";
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."deck_role" AS ENUM('owner', 'editor', 'viewer');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "deck_permissions" (
  "deck_id"    text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "user_id"    text NOT NULL,
  "role"       "deck_role" NOT NULL,
  "granted_at" timestamp NOT NULL DEFAULT now(),
  "granted_by" text,
  CONSTRAINT "deck_permissions_pkey" PRIMARY KEY ("deck_id", "user_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "deck_permissions_user_idx" ON "deck_permissions" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "share_links" (
  "id"         text PRIMARY KEY NOT NULL,
  "deck_id"    text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "role"       "deck_role" NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp,
  "created_by" text NOT NULL,
  "revoked"    boolean NOT NULL DEFAULT false
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "share_links_deck_idx" ON "share_links" ("deck_id");
