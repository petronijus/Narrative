-- 0042 (ADR 0017, security review M1): the instance's restore generation.
-- Browsers keep local copies of documents and claim, when they connect, the
-- epoch of what their copy holds: `<generation>.<doc_epoch>`. A restore of
-- the database from a backup rolls every `doc_epoch` back with the rows, so
-- the document epoch alone cannot tell a copy taken after the backup; the
-- generation can: backup.sh advances it after each dump and writes it to a
-- marker outside Postgres, and a server that boots with a database whose
-- generation is below the marker was restored — it moves generation and
-- floor past everything ever issued (hocuspocus/instanceGeneration.ts), and
-- the sync server refuses every claim below the floor. Values are unix
-- seconds of the last advance, so "past everything ever issued" is also
-- "now" when the marker is lost (the manual restore step, docs/deploy.md).

CREATE TABLE IF NOT EXISTS "instance_generation" (
  "id" smallint PRIMARY KEY DEFAULT 1,
  "generation" bigint NOT NULL,
  "floor" bigint NOT NULL,
  CONSTRAINT "instance_generation_single_row" CHECK ("id" = 1),
  CONSTRAINT "instance_generation_floor_le_generation" CHECK ("floor" <= "generation")
);
--> statement-breakpoint
INSERT INTO "instance_generation" ("id", "generation", "floor")
VALUES (1, extract(epoch from now())::bigint, 1)
ON CONFLICT ("id") DO NOTHING;
