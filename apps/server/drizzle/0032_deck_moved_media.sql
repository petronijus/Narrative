-- Folder sharing, step 2 (docs/plans/folder-sharing.md → "Step 2 design"):
-- the linked media a deck took along when it left a folder. A deck links the
-- pictures and videos of its folder without owning them; moving it copies
-- what it links into the deck and points the deck at the copies
-- (services/localiseMedia.ts). One row per linked asset the deck referenced
-- when it moved: the asset, its copy, the folder it came from and who moved
-- the deck.
--
-- An undo in an editor, or an agent run's revert, can bring an old reference
-- back. The server then only re-points it at the recorded copy — never copies
-- an asset that has no row here. A fresh copy is made only when the recorded
-- copy is gone, at most once per row (`recopied_at`), on the mover's
-- authority and copy budget.
--
-- The source asset id is a reference documents may hold, not a key: the
-- picture may be deleted from its folder later, and the copy still serves the
-- deck. The copy, the folder and the mover go to NULL when they are deleted
-- (no dangling ids): a row without a copy can be copied once more, one
-- without a folder or a mover cannot.
CREATE TABLE IF NOT EXISTS "deck_moved_media" (
  "deck_id" text NOT NULL REFERENCES "decks"("id") ON DELETE CASCADE,
  "source_asset_id" text NOT NULL,
  "copy_asset_id" text REFERENCES "media_assets"("id") ON DELETE SET NULL,
  "from_folder_id" text REFERENCES "folders"("id") ON DELETE SET NULL,
  "moved_by_user_id" text REFERENCES "users"("sub") ON DELETE SET NULL,
  "moved_at" timestamp DEFAULT now() NOT NULL,
  "recopied_at" timestamp,
  PRIMARY KEY ("deck_id", "source_asset_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_moved_media_copy_idx" ON "deck_moved_media" ("copy_asset_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_moved_media_folder_idx" ON "deck_moved_media" ("from_folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deck_moved_media_mover_idx" ON "deck_moved_media" ("moved_by_user_id");
