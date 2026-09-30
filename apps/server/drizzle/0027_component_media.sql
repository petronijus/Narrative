-- Agentic A2.12b (2026-09-30): pictures and videos of a component master
-- belong to the component. Until now a master only pointed at the media of
-- the deck it was promoted from (lost with that deck, and shown to nobody
-- without access to it), and uploads into the master editor had no owner.
-- A media row now has exactly one owner: a deck (deck_id), a component
-- (component_id, keys under components/<id>/), or — for fonts — a folder.

ALTER TABLE "media_assets"
  ADD COLUMN IF NOT EXISTS "component_id" text REFERENCES "components"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "media_assets_component_id_idx" ON "media_assets" ("component_id");
