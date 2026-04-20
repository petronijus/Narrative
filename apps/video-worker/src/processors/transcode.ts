import type { Job } from 'bullmq'
import type { VideoTranscodeJobData, VideoTranscodeResult } from '../queue.js'

/**
 * Placeholder implementation for M12 phase 1a.
 *
 * Media agent (phase 2) replaces this with the real ffmpeg pipeline:
 *   1. Stream original from MinIO to /tmp/<assetId>.<ext>
 *   2. Run ffmpeg transcodes:
 *        - 360p, 720p, 1080p HLS segments (segmented .ts files + variant playlists)
 *        - Poster frame (first I-frame → poster.jpg via ffmpeg -vframes 1)
 *        - Thumbnail (poster scaled to 320px wide)
 *   3. Upload all outputs to MinIO under:
 *        decks/<deckId>/videos/<assetId>/{master.m3u8, 360p/, 720p/, 1080p/, poster.jpg, thumb.jpg}
 *   4. Probe width/height/duration via ffprobe (JSON output)
 *   5. UPDATE media_assets SET
 *        status = 'ready',
 *        hls_manifest_key = ...,
 *        poster_key = ...,
 *        thumbnail_key = ...,
 *        duration_sec = ...,
 *        width = ...,
 *        height = ...
 *      WHERE id = assetId
 *
 * Phases beyond M12: audio-only fallback, DRM (M29+), adaptive bitrate tuning.
 */
export async function transcodeProcessor(
  job: Job<VideoTranscodeJobData, VideoTranscodeResult>,
): Promise<VideoTranscodeResult> {
  throw new Error(
    `transcodeProcessor not implemented (job=${job.id}, assetId=${job.data.assetId}) — media agent phase 2 will replace this stub`,
  )
}
