-- Migration: 0004_p15_font_assets
-- P15 custom fonts: extend media_assets so fonts share the same storage,
-- RBAC, and lifecycle as images and videos.
--
-- 1. Add 'font' to the media_asset_kind enum.
-- 2. Add four nullable font-metadata columns populated from opentype.js
--    parse during the tus onUploadFinish hook. They stay NULL for
--    image / video rows.
--
-- Down (manual — drizzle-kit does not auto-generate rollbacks):
--   ALTER TABLE media_assets DROP COLUMN font_postscript_name;
--   ALTER TABLE media_assets DROP COLUMN font_style;
--   ALTER TABLE media_assets DROP COLUMN font_weight;
--   ALTER TABLE media_assets DROP COLUMN font_family;
--   -- enum value drop is awkward in postgres; recreate the enum if needed.
--> statement-breakpoint

ALTER TYPE "media_asset_kind" ADD VALUE IF NOT EXISTS 'font';
--> statement-breakpoint

ALTER TABLE "media_assets" ADD COLUMN "font_family" text;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "font_weight" integer;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "font_style" text;
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "font_postscript_name" text;
