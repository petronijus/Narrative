export const VIDEO_TRANSCODE_QUEUE = 'video-transcode'

export interface VideoTranscodeJobData {
  assetId: string // media_assets row id
  deckId: string
  storageKey: string // original upload key in MinIO (e.g. uploads/<assetId>)
  uploaderUserId: string
  mimeType: string
}

export interface VideoTranscodeResult {
  assetId: string
  posterKey: string // decks/<deckId>/videos/<assetId>/poster.jpg
  thumbnailKey: string // decks/<deckId>/videos/<assetId>/thumb.jpg
  hlsManifestKey: string // decks/<deckId>/videos/<assetId>/master.m3u8
  durationSec: number
  width: number
  height: number
}
