-- Migration: 0003_m12_video_columns
-- M12 phase 1b: extend media_assets with video-specific columns + enums
-- Created: 2026-04-20
--
-- Adds two PG enums and seven new columns to media_assets.
-- Existing image rows are backfilled to kind='image' before the NOT NULL
-- constraint is applied — zero downtime for existing data.
--
-- Down (manual — Drizzle does not auto-generate rollbacks):
--   ALTER TABLE media_assets DROP COLUMN transcode_error;
--   ALTER TABLE media_assets DROP COLUMN transcode_status;
--   ALTER TABLE media_assets DROP COLUMN thumbnail_key;
--   ALTER TABLE media_assets DROP COLUMN poster_key;
--   ALTER TABLE media_assets DROP COLUMN hls_manifest_key;
--   ALTER TABLE media_assets DROP COLUMN duration_sec;
--   ALTER TABLE media_assets DROP COLUMN kind;
--   DROP TYPE IF EXISTS media_transcode_status;
--   DROP TYPE IF EXISTS media_asset_kind;
--> statement-breakpoint

CREATE TYPE "media_asset_kind" AS ENUM ('image', 'video');
--> statement-breakpoint

CREATE TYPE "media_transcode_status" AS ENUM ('pending', 'processing', 'done', 'failed');
--> statement-breakpoint

-- Add columns nullable first so existing rows are not broken
ALTER TABLE "media_assets" ADD COLUMN "kind" "media_asset_kind";
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "duration_sec" integer;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "hls_manifest_key" text;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "poster_key" text;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "thumbnail_key" text;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "transcode_status" "media_transcode_status";
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "transcode_error" text;
--> statement-breakpoint

-- Backfill kind from mime_type for existing rows
UPDATE "media_assets" SET "kind" = 'image' WHERE "mime_type" LIKE 'image/%';
--> statement-breakpoint
UPDATE "media_assets" SET "kind" = 'video' WHERE "mime_type" LIKE 'video/%';
--> statement-breakpoint
-- Safety fallback: any unrecognised mime_type gets 'image'
UPDATE "media_assets" SET "kind" = 'image' WHERE "kind" IS NULL;
--> statement-breakpoint

-- Now it is safe to add NOT NULL + DEFAULT
ALTER TABLE "media_assets" ALTER COLUMN "kind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "kind" SET DEFAULT 'image';
