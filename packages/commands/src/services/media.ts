/**
 * `MediaService` — defined here, implemented by apps/server/src/services/media.ts.
 * See ../services.ts for the pattern: the /api/media routes, the tus upload
 * pipeline and the `media.*` commands share these implementations.
 *
 * Methods that take `deckId` / `folderId` as an EXPECTATION (optional) fail
 * with `not_found` when the asset belongs elsewhere — that is how a command
 * scoped to one deck cannot reach another deck's media.
 */

import type { BinarySource, DocumentRef } from './common.js'

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

/**
 * A one-time upload session (`media.uploadSession`): how to send one file to
 * the tus upload with a single request. The token authenticates that upload
 * only (media/uploadSessions.ts on the server).
 */
export interface UploadSessionInfo {
  /** The tus creation endpoint (absolute). */
  url: string
  /** The one-time bearer token (`nus_…`). */
  token: string
  /** Until when the upload may be started (ISO 8601). */
  expiresAt: string
  /** The tus `Upload-Metadata` header value (deck, filename, type). */
  uploadMetadata: string
  kind: 'image' | 'video' | 'font'
  mimeType: string
  /** The exact size the upload must have (`Upload-Length`). */
  sizeBytes: number
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
   * Store an image, video or font for a deck, or an image or video for a
   * component master (`owner`; a master takes no fonts — its folder's cover
   * it). The bytes go through the same checks as a browser upload: per-kind
   * size limits, SVG sanitisation, magic-byte checks for rasters,
   * downscaling to the stored-image limits, font parsing, and a transcode
   * job for videos.
   */
  upload(args: {
    userId: string
    owner: DocumentRef
    source: BinarySource
  }): Promise<MediaUploadResult>
  /**
   * Open a one-time upload session for ONE image, video or font into a deck
   * (editor access), or ONE image or video into a component master (owning
   * its folder): the caller sends the file itself to the tus upload the
   * editor uses. For agents with a shell, whose files cannot travel through
   * the model as base64.
   */
  openUploadSession(args: {
    userId: string
    owner: DocumentRef
    filename: string
    mimeType?: string | undefined
    /** The file's exact size: the session uploads that file only. */
    sizeBytes: number
    /** The credential asking (AgentSessionInfo.credential); revoking it ends the session. */
    credentialKey?: string | undefined
  }): Promise<UploadSessionInfo>
  /**
   * Transcode state and playback URLs of a video: viewer access to its deck,
   * or read access to its component's folder (a member, or a guest of one
   * of the folder's decks, share links included). With `owner`, the asset must
   * belong to that deck or component.
   */
  videoInfo(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    owner?: DocumentRef | undefined
  }): Promise<VideoInfo>
  /** Signed imgproxy URL of an image (access and `owner` as `videoInfo`). */
  url(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    variant: ImageVariant
    owner?: DocumentRef | undefined
  }): Promise<{ url: string }>
  /** Presigned URL of a folder font file (its folder's members and deck guests). */
  fontUrl(args: {
    userId: string
    assetId: string
    folderId?: string | undefined
  }): Promise<FontUrlInfo>
  /**
   * Remove an asset from its owner's media — of `owner` when named (a deck,
   * a component master, or a folder's own media), else wherever it lives. A
   * deck's asset is deleted (its row and stored files) by the deck's owner.
   * A component master's picture or video is detached from the master and
   * handed to its folder (the master no longer owns it; stamps keep showing
   * it) by an editor of the folder. A folder's own picture or video is
   * deleted only by the folder's owner. A folder font is refused here:
   * folder.fonts.delete removes it.
   */
  delete(args: {
    userId: string
    assetId: string
    owner?: MediaOwnerRef | undefined
  }): Promise<{ outcome: MediaDeleteOutcome }>
}

/** Whose media an asset is: a deck's, a component master's, or a folder's own. */
export type MediaOwnerRef = DocumentRef | { folderId: string }

/** What removing an asset did: `deleted` (row and files gone) or `handedToFolder` (a master's, now its folder's). */
export type MediaDeleteOutcome = 'deleted' | 'handedToFolder'
