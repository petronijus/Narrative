-- 0015: Composite (parent, kind) indexes on media_assets.
--
-- Hot-path lookups filter media by (deck/folder, kind) — e.g. list a deck's
-- videos, or a folder's fonts (apps/server/src/media/assets.ts). The existing
-- single-column indexes on deck_id / folder_id force a kind filter + heap
-- scan; these composites let Postgres satisfy both predicates from the index.
--
-- We keep the original single-column indexes for paths that filter by parent
-- alone — IF NOT EXISTS makes this migration idempotent.

CREATE INDEX IF NOT EXISTS media_assets_deck_kind_idx
  ON media_assets (deck_id, kind);

CREATE INDEX IF NOT EXISTS media_assets_folder_kind_idx
  ON media_assets (folder_id, kind);
