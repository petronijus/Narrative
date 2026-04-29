-- Adds server-side deck thumbnail tracking.
-- thumbnail_key references a MinIO object under decks/<deck_id>/thumb.jpg.
-- thumbnail_updated_at lets the client cache-bust signed imgproxy URLs.
ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "thumbnail_key" text;
ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "thumbnail_updated_at" timestamp;
