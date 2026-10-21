-- 0041 (ADR 0017): the epoch of each Yjs document. The browser keeps a local
-- copy of what the server confirmed and claims the epoch of what its document
-- holds when it connects; the sync server refuses a claim that is not the
-- current epoch (hocuspocus/authenticate.ts), so a copy from before a
-- document was REPLACED (not edited through the sync server) never merges
-- its old items back. Every document starts at 1; whatever replaces a
-- document's state bumps it (hocuspocus/documentEpoch.ts).

ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "doc_epoch" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN IF NOT EXISTS "doc_epoch" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN IF NOT EXISTS "doc_epoch" integer DEFAULT 1 NOT NULL;
