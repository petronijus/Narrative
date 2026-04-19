-- Migration: 0000_initial_schema
-- Created: 2026-04-19
-- Drizzle ORM migration for Narrative M4
--
-- Tables:
--   decks        — presentation metadata
--   deck_updates — append-only Yjs update log (bytea)

CREATE TABLE IF NOT EXISTS "decks" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL DEFAULT 'Untitled Deck',
  "owner_user_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "deck_updates" (
  "id" serial PRIMARY KEY NOT NULL,
  "deck_id" text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "update" bytea NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "deck_updates_deck_id_idx" ON "deck_updates" ("deck_id");
