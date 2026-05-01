-- M16 P2: folder_updates — append-only Yjs update log for folder design-token docs.
-- Mirrors deck_updates but keyed by folder_id instead of deck_id.
-- Each folder has a Hocuspocus document named `folder:<folder_id>` whose Y.Doc
-- holds the tokens Y.Map (colors, textStyles, effectStyles).

CREATE TABLE IF NOT EXISTS "folder_updates" (
  "id"          serial PRIMARY KEY,
  "folder_id"   text NOT NULL REFERENCES "folders" ("id") ON DELETE CASCADE,
  "update"      bytea NOT NULL,
  "created_at"  timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "folder_updates_folder_id_idx" ON "folder_updates" ("folder_id");
