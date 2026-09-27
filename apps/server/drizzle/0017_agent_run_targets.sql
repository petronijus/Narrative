-- Agentic layer A1 (docs/plans/agentic-layer.md §6, ADR 0011): what a run and
-- each of its ops targeted.
--
-- agent_runs.component_id: a run that edits a component master (the server
--   host opens `component:<id>`) instead of a deck. A run has a deck, a
--   component, or neither (account- and folder-level work such as creating a
--   deck or editing folder tokens).
-- agent_ops.target: the command's target as the host authorised it
--   ({ deckId } | { componentId } | { folderId } | {}), so the audit trail
--   says what a folder- or account-scoped op acted on even though its input
--   does not name it.

ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "component_id" text REFERENCES "components"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_component_id_idx" ON "agent_runs" ("component_id", "created_at");
--> statement-breakpoint
ALTER TABLE "agent_ops" ADD COLUMN IF NOT EXISTS "target" jsonb;
