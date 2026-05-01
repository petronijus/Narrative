-- M16 P3: folder_fonts — add folder_id to media_assets for folder-scoped font rows.
--
-- When kind='font' and folder_id IS NOT NULL, the row is a folder-level font.
-- Existing deck-scoped font rows (kind='font', folder_id IS NULL) remain valid.
-- On folder delete → CASCADE removes all associated font rows.
--
-- The deckId column is already NOT NULL in media_assets, so we need a deck anchor
-- for folder fonts too. We will store a sentinel deckId = '' is NOT acceptable.
-- Instead, we make deckId nullable in this migration so folder fonts can omit it.
-- Existing rows are unchanged (deckId stays populated for all image/video/deck-font rows).

-- Step 1: make deckId nullable so folder-scoped fonts don't need a deckId
ALTER TABLE "media_assets"
  ALTER COLUMN "deck_id" DROP NOT NULL;

-- Step 2: add folder_id column (nullable; set only for folder-scoped fonts)
ALTER TABLE "media_assets"
  ADD COLUMN IF NOT EXISTS "folder_id" text REFERENCES "folders" ("id") ON DELETE CASCADE;

-- Step 3: index to support fast lookup of fonts by folder
CREATE INDEX IF NOT EXISTS "media_assets_folder_id_idx" ON "media_assets" ("folder_id");
