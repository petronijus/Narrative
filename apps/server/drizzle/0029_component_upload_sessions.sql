-- A2.12b: an upload session (media.uploadSession) may upload into a
-- component master as well as into a deck — an agent with a shell sends a
-- local picture to a master with curl instead of writing it out as base64.
ALTER TABLE "upload_sessions" ALTER COLUMN "deck_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_sessions"
  ADD COLUMN IF NOT EXISTS "component_id" text REFERENCES "components"("id") ON DELETE CASCADE;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_one_owner') THEN
    ALTER TABLE "upload_sessions"
      ADD CONSTRAINT "upload_sessions_one_owner" CHECK (num_nonnulls("deck_id", "component_id") = 1);
  END IF;
END $$;
