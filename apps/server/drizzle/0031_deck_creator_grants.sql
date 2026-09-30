-- Folder sharing (docs/plans/folder-sharing.md, ADR 0013): a deck's access is
-- decided by deck_permissions and folder_permissions alone. Until now
-- resolveDeckAccess also treated decks.owner_user_id as an owner, a grant that
-- could not be revoked. Every deck's creator gets that role as a row, so
-- dropping the fallback changes nobody's access: a missing row is inserted,
-- and a lower row is raised to owner (the fallback outranked it anyway).
INSERT INTO "deck_permissions" ("deck_id", "user_id", "role", "granted_by")
SELECT "id", "owner_user_id", 'owner', NULL FROM "decks"
ON CONFLICT ("deck_id", "user_id") DO UPDATE SET "role" = 'owner'
WHERE "deck_permissions"."role" <> 'owner';
