-- Folder sharing (docs/plans/folder-sharing.md, step 3 review, Petr
-- 2026-10-04): a user's Drafts folder is marked, not recognised by its
-- name. Folders now have several owners, any of whom may rename one: a
-- shared folder renamed "Drafts" must not become someone's Drafts (their
-- new decks would land where every member sees them), and a Drafts renamed
-- away must not become shareable. Drafts stays private, undeletable and
-- unshareable by this flag.
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "is_drafts" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill: each user's Drafts is the oldest folder they created named
-- "Drafts" (the folder getOrProvisionDrafts returned until now).
UPDATE "folders" f SET "is_drafts" = true
FROM (
  SELECT DISTINCT ON ("owner_user_id") "id"
  FROM "folders"
  WHERE "name" = 'Drafts'
  ORDER BY "owner_user_id", "created_at", "id"
) d
WHERE f."id" = d."id";
--> statement-breakpoint
-- One Drafts per user.
CREATE UNIQUE INDEX IF NOT EXISTS "folders_one_drafts_per_owner"
  ON "folders" ("owner_user_id") WHERE "is_drafts";
