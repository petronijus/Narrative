-- M16 P1: Flat folders — single-level, owner-scoped.
-- Each deck must belong to exactly one folder.
-- Migration:
--   1. Create folders table.
--   2. For each distinct owner_user_id in decks, create a "Drafts" folder.
--   3. Add folder_id column (nullable first), backfill, then set NOT NULL.

-- ---------------------------------------------------------------------------
-- 1. folders table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "folders" (
  "id"            text PRIMARY KEY,
  "owner_user_id" text NOT NULL,
  "name"          text NOT NULL,
  "created_at"    timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "folders_owner_user_id_idx" ON "folders" ("owner_user_id");

-- ---------------------------------------------------------------------------
-- 2. Backfill "Drafts" folder for every distinct deck owner (including legacy users)
-- ---------------------------------------------------------------------------

INSERT INTO "folders" ("id", "owner_user_id", "name", "created_at")
SELECT
  -- Stable deterministic id: 'drafts-' + owner_user_id, truncated/padded to 12 chars
  -- Using md5 prefix keeps ids collision-free and short.
  'drafts-' || md5("owner_user_id"),
  "owner_user_id",
  'Drafts',
  now()
FROM (
  SELECT DISTINCT "owner_user_id" FROM "decks"
) AS owners
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Add folder_id column to decks (nullable first for backfill)
-- ---------------------------------------------------------------------------

ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "folder_id" text;

-- Backfill: assign each deck to its owner's Drafts folder
UPDATE "decks"
SET "folder_id" = 'drafts-' || md5("owner_user_id")
WHERE "folder_id" IS NULL;

-- Now make it NOT NULL and add FK
ALTER TABLE "decks" ALTER COLUMN "folder_id" SET NOT NULL;

ALTER TABLE "decks"
  ADD CONSTRAINT "decks_folder_id_fkey"
  FOREIGN KEY ("folder_id") REFERENCES "folders" ("id") ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS "decks_folder_id_idx" ON "decks" ("folder_id");
