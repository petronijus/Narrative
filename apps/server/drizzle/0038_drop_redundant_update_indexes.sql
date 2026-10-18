-- 0038 (docs/plans/performance.md B4): drop the single-column indexes of the
-- three Yjs update tables. Each is a prefix of the composite (parent_id, id)
-- index 0011 added, so every query that filters by the parent — the load
-- (`WHERE <parent>_id = ? ORDER BY id`), the compaction after each store
-- (`DELETE … WHERE <parent>_id = ? AND id < ?`), the cascade from the owner's
-- delete, the agent host's folder-document version (`max(id)`) — uses the
-- composite. 0011 kept the old ones "for any code path that filters without
-- ordering"; that path takes the composite too. Checked on the dev database
-- (2026-10-18) with EXPLAIN before and after dropping them, and by
-- pg_stat_user_indexes: 2, 0 and 0 scans of the single-column indexes
-- against 7164, 2647 and 58 of the composites. Each store inserts one row and
-- deletes the older ones, so every index is maintained on every store.
--
-- A plain DROP INDEX (not CONCURRENTLY, which cannot run inside the
-- migrator's per-file transaction): it holds an exclusive lock on the table
-- only for the catalog change. IF EXISTS keeps it re-runnable.

DROP INDEX IF EXISTS "deck_updates_deck_id_idx";

DROP INDEX IF EXISTS "folder_updates_folder_id_idx";

DROP INDEX IF EXISTS "component_updates_component_id_idx";
