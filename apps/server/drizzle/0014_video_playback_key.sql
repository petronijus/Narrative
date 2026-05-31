-- 0014_video_playback_key.sql
--
-- Video pipeline migration: stop transcoding to downscaled HLS variants.
-- Instead the worker now produces a single progressive MP4 (faststart)
-- served via a plain <video> over MinIO byte-range requests.
--
-- The old HLS master-playlist pointer column is dropped and replaced by a
-- single MP4 playback-key column. Existing rows lose their (now-unused) HLS
-- key; re-uploading or re-running the worker repopulates `playback_key`.

ALTER TABLE "media_assets" DROP COLUMN "hls_manifest_key";
ALTER TABLE "media_assets" ADD COLUMN "playback_key" text;
