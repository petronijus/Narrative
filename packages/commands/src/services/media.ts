/**
 * `MediaService` — defined here, implemented by apps/server/src/services/media.ts.
 * See ../services.ts for the pattern: the /api/media routes, the tus upload
 * pipeline and the `media.*` commands share these implementations.
 *
 * Methods that take `deckId` / `folderId` as an EXPECTATION (optional) fail
 * with `not_found` when the asset belongs elsewhere — that is how a command
 * scoped to one deck cannot reach another deck's media.
 */

import type { BinarySource } from './common.js'

export type MediaKind = 'image' | 'video' | 'font'
export type ImageVariant = 'thumb' | 'preview' | 'display' | 'original'

export interface MediaUploadResult {
  assetId: string
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  /** Pixel size of images (after any downscale to the stored-image limits); null when unknown. */
  width: number | null
  height: number | null
  /** Videos: `pending` until the transcode finishes (poll `videoInfo`). */
  transcodeStatus?: 'pending' | undefined
  /** Fonts: what the file says about itself. */
  font?:
    | { family: string; weight: number; style: string; postscriptName: string | null }
    | undefined
}

export interface VideoInfo {
  assetId: string
  transcodeStatus: 'pending' | 'processing' | 'done' | 'failed' | null
  durationSec: number | null
  width: number | null
  height: number | null
  posterUrl: string | null
  thumbnailUrl: string | null
  playbackUrl: string | null
  transcodeError: string | null
}

export interface FontUrlInfo {
  assetId: string
  url: string
  family: string | null
  weight: number | null
  style: string | null
  postscriptName: string | null
  mimeType: string
}

export interface MediaService {
  /**
   * Store an image, video or font for a deck. The bytes go through the same
   * checks as a browser upload: per-kind size limits, SVG sanitisation,
   * magic-byte checks for rasters, downscaling to the stored-image limits,
   * font parsing, and a transcode job for videos.
   */
  upload(args: { userId: string; deckId: string; source: BinarySource }): Promise<MediaUploadResult>
  /** Transcode state and playback URLs of a video (viewer access to its deck). */
  videoInfo(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    deckId?: string | undefined
  }): Promise<VideoInfo>
  /** Signed imgproxy URL of an image (viewer access to its deck). */
  url(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    variant: ImageVariant
    deckId?: string | undefined
  }): Promise<{ url: string }>
  /** Presigned URL of a folder font file (folder owner only). */
  fontUrl(args: {
    userId: string
    assetId: string
    folderId?: string | undefined
  }): Promise<FontUrlInfo>
  /** Remove an asset's row (deck owner only). */
  delete(args: { userId: string; assetId: string; deckId?: string | undefined }): Promise<void>
}
