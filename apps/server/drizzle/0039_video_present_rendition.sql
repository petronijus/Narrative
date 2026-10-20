-- 0039 (docs/plans/performance.md P3): the 1080p playback rendition of a
-- video larger than 1920×1080. The video worker writes present.mp4 beside
-- playback.mp4 (<prefix>/videos/<assetId>/, the layout is unchanged) and
-- records its key and size here; present mode plays it when the slide is
-- shown at 1080p or less, the original playback otherwise. NULL for smaller
-- videos, images, and videos transcoded before this migration
-- (`pnpm --filter server db:backfill-video --all` re-runs them).
--
-- Nullable columns without defaults: a catalog-only change, no table rewrite.

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "present_playback_key" text;

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "present_width" integer;

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "present_height" integer;
