-- 0011: Composite indexes (parent_id, id) for the three Yjs update logs.
--
-- onLoadDocument runs `SELECT update FROM <log> WHERE <parent>_id = ? ORDER BY id`.
-- The existing single-column indexes on parent_id force a sort step. With a
-- composite index Postgres can do an index-only ordered scan, eliminating the
-- sort and making cold-load latency O(rows-returned) instead of O(rows-in-table
-- for the tenant) + sort.
--
-- We keep the original single-column indexes for any code path that filters
-- without ordering — IF NOT EXISTS makes this idempotent.

CREATE INDEX IF NOT EXISTS deck_updates_deck_id_id_idx
  ON deck_updates (deck_id, id);

CREATE INDEX IF NOT EXISTS folder_updates_folder_id_id_idx
  ON folder_updates (folder_id, id);

CREATE INDEX IF NOT EXISTS component_updates_component_id_id_idx
  ON component_updates (component_id, id);
