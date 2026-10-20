-- 0040 (docs/storage.md → "Deleting an owner"): the second prefix sweep of a
-- deleted deck or component, kept in the database instead of a timer in the
-- server process. The first sweep, at the delete, keeps every object younger
-- than the grace window (a copy or a transcode still writing); the second
-- one, after the window, used to be an in-process setTimeout that every
-- restart forgot — a dev server restarting on each edit left whole decks of
-- media behind (5.8 GiB of 26 decks in the dev bucket, 2026-10-20).
--
-- A row is written with the delete and removed once its sweep ran without
-- an error (media/ownerSweeps.ts). `due_at` is when it may run next; a
-- process that takes a row moves it forward, so another process skips it.

CREATE TABLE IF NOT EXISTS "media_owner_sweeps" (
  "owner_kind" text NOT NULL,
  "owner_id" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_owner_sweeps_pk" PRIMARY KEY ("owner_kind", "owner_id"),
  CONSTRAINT "media_owner_sweeps_kind_check" CHECK ("owner_kind" IN ('deck', 'component'))
);

CREATE INDEX IF NOT EXISTS "media_owner_sweeps_due_idx" ON "media_owner_sweeps" ("due_at");
