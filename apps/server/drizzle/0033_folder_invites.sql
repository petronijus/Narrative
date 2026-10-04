-- Folder sharing, step 3 (docs/plans/folder-sharing.md): pending invitations
-- to a folder by e-mail, for people who have not signed in to Narrative yet.
-- The same lifecycle as deck_invites (0013): the folder's owner invites an
-- address, the invitee signs in with Google, and /auth/callback turns every
-- pending invite for that address into a folder_permissions row and marks it
-- accepted. A pending invite also lets that address sign in at all
-- (auth/signInPolicy.ts).
CREATE TABLE IF NOT EXISTS "folder_invites" (
  "id" text PRIMARY KEY,                 -- nanoid(12)
  "folder_id" text NOT NULL REFERENCES "folders"("id") ON DELETE CASCADE,
  "email" text NOT NULL,                 -- lower-cased on insert
  "role" "deck_role" NOT NULL,
  "invited_by_sub" text NOT NULL,
  "invited_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,     -- 30 days from the (last) invitation
  "accepted_at" timestamptz,
  "accepted_by_sub" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_invites_folder_id_idx" ON "folder_invites" ("folder_id");
--> statement-breakpoint
-- One pending invite per (folder, address); inviting again updates it.
CREATE UNIQUE INDEX IF NOT EXISTS "folder_invites_folder_email_pending_uniq"
  ON "folder_invites" ("folder_id", LOWER("email"))
  WHERE "accepted_at" IS NULL;
--> statement-breakpoint
-- Sign-in and invite pick-up look pending invites up by address.
CREATE INDEX IF NOT EXISTS "folder_invites_email_pending_idx"
  ON "folder_invites" (LOWER("email"))
  WHERE "accepted_at" IS NULL;
