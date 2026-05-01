-- M16 P5: Component master data model.
--
-- Two new tables:
--   components        — metadata per master component (id, folder_id, name, thumbnail_key)
--   component_updates — append-only Yjs update log for component:<id> docs
--
-- Mirrors the folders / folder_updates pattern.

-- ---------------------------------------------------------------------------
-- components
-- ---------------------------------------------------------------------------

CREATE TABLE "components" (
  "id"            text PRIMARY KEY,
  "folder_id"     text NOT NULL REFERENCES "folders"("id") ON DELETE CASCADE,
  "name"          text NOT NULL DEFAULT 'Untitled component',
  "thumbnail_key" text,
  "created_at"    timestamp DEFAULT now() NOT NULL,
  "updated_at"    timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "components_folder_id_idx" ON "components" ("folder_id");

-- ---------------------------------------------------------------------------
-- component_updates
-- ---------------------------------------------------------------------------

CREATE TABLE "component_updates" (
  "id"           serial PRIMARY KEY,
  "component_id" text NOT NULL REFERENCES "components"("id") ON DELETE CASCADE,
  "update"       bytea NOT NULL,
  "created_at"   timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "component_updates_component_id_idx" ON "component_updates" ("component_id");
