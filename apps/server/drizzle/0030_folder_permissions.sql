-- Folder sharing (docs/plans/folder-sharing.md): who may see and change a
-- folder, with the deck roles. A folder member sees everything in the folder
-- (its decks, components, media, fonts and tokens); the role applies to all
-- of it. Every existing folder gets its owner as its first member, so nothing
-- changes until someone is invited.
CREATE TABLE IF NOT EXISTS "folder_permissions" (
  "folder_id" text NOT NULL REFERENCES "folders"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "role" "deck_role" NOT NULL,
  "granted_at" timestamp DEFAULT now() NOT NULL,
  "granted_by" text,
  PRIMARY KEY ("folder_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_permissions_user_idx" ON "folder_permissions" ("user_id");
--> statement-breakpoint
INSERT INTO "folder_permissions" ("folder_id", "user_id", "role", "granted_by")
SELECT "id", "owner_user_id", 'owner', NULL FROM "folders"
ON CONFLICT DO NOTHING;
