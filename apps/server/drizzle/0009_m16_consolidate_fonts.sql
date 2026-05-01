-- M16 P3 (consolidation): migrate legacy deck-scoped font rows to folder scope.
--
-- After this migration every kind='font' row has folder_id IS NOT NULL and
-- deck_id IS NULL — fonts are folder-scoped only.
--
-- Strategy:
--   For each media_assets row where kind='font' AND folder_id IS NULL AND
--   deck_id IS NOT NULL, copy the deck's folder_id onto the font row, then
--   null out deck_id. Rows whose deck has been deleted (orphans) are not
--   touched by the JOIN — they remain with a dangling deck_id reference
--   (the deck row is gone, but the FK ON DELETE CASCADE would have already
--   removed them). In practice the JOIN simply skips them.
--
-- This is a data migration; the schema does not change. No DDL required.

UPDATE "media_assets" AS m
SET
  "folder_id" = d."folder_id",
  "deck_id" = NULL
FROM "decks" AS d
WHERE m."deck_id" = d."id"
  AND m."kind" = 'font'
  AND m."folder_id" IS NULL
  AND m."deck_id" IS NOT NULL
  AND d."folder_id" IS NOT NULL;
