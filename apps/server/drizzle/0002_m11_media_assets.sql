-- Migration: 0002_m11_media_assets
-- M11 phase 1b: media_assets table for uploaded originals
-- Created: 2026-04-20
--
-- Tracks every uploaded original file associated with a deck.
-- imgproxy variants (thumb, display, original) are generated on demand —
-- no variant rows are stored here.
--
-- KNOWN ISSUE: ON DELETE CASCADE from decks removes media_assets rows when a
-- deck is deleted, but leaves the original files orphaned in MinIO. This is
-- intentional for M11. A post-delete hook or periodic GC job should be added
-- in media phase 2 or M29 to enqueue bucket cleanup for orphaned objects.
-- TODO(M29 or media phase 2): implement MinIO cleanup for deleted deck assets.
--
-- Down (manual — drizzle-kit does not auto-generate rollbacks):
--   DROP TABLE IF EXISTS "media_assets";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "media_assets" (
  "id"                 text PRIMARY KEY NOT NULL,
  "deck_id"            text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "uploader_user_id"   text NOT NULL,
  "mime_type"          text NOT NULL,
  "size_bytes"         integer NOT NULL,
  "storage_key"        text NOT NULL,
  "original_filename"  text,
  "width"              integer,
  "height"             integer,
  "created_at"         timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "media_assets_deck_idx" ON "media_assets" ("deck_id");
