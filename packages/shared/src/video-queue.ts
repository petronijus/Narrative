/**
 * video-queue.ts
 *
 * Shared BullMQ queue name and job data types for the video transcode pipeline.
 * Imported by both apps/server (enqueue) and apps/video-worker (consume).
 *
 * Kept in @narrative/shared so neither app depends on the other directly.
 */

export const VIDEO_TRANSCODE_QUEUE = 'video-transcode'

export interface VideoTranscodeJobData {
  /** media_assets row id (nanoid 16) */
  assetId: string
  deckId: string
  /** Original upload key in MinIO, e.g. decks/<deckId>/uploads/<assetId>/original.mp4 */
  storageKey: string
  uploaderUserId: string
  mimeType: string
}

export interface VideoTranscodeResult {
  assetId: string
  /** decks/<deckId>/videos/<assetId>/poster.jpg */
  posterKey: string
  /** decks/<deckId>/videos/<assetId>/thumb.jpg */
  thumbnailKey: string
  /** decks/<deckId>/videos/<assetId>/master.m3u8 */
  hlsManifestKey: string
  durationSec: number
  width: number
  height: number
}
