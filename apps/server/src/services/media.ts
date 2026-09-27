/**
 * services/media.ts — server implementation of `MediaService`
 * (packages/commands/src/services/media.ts). The /api/media routes and the
 * `media.*` commands call these functions; uploads go through the same
 * finalize step as the tus upload (media/finalizeUpload.ts) and the same
 * policy (media/uploadPolicy.ts).
 */

import { nanoid } from 'nanoid'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type {
  BinarySource,
  FontUrlInfo,
  ImageVariant,
  MediaService,
  MediaUploadResult,
  VideoInfo,
} from '@narrative/commands'
import { deleteMediaAsset, getFontAsset, getMediaAsset, getVideoAsset } from '../media/assets.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from '../media/s3Client.js'
import { finalizeMediaUpload, UploadRejected } from '../media/finalizeUpload.js'
import {
  classifyUpload,
  extensionFromMimeOrFilename,
  maxUploadBytes,
  MAX_FONT_UPLOAD_SIZE,
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE,
  sniffMime,
  tooLargeMessage,
  type UploadKind,
} from '../media/uploadPolicy.js'
import { resolveDeckAccess, roleAtLeast } from '../auth/permissions.js'
import type { ServiceDeps } from './deps.js'
import { ServiceError, forbidden, notFound, tooLarge, unsupportedType } from './errors.js'
import { requireOwnedFolder } from './shared.js'
import { LARGE_DOWNLOAD_TIMEOUT_MS, withBinarySource, type BinaryFile } from './binarySource.js'

// Presigned-URL TTLs (MEDIA-1). The bucket is private; clients reach video
// and font bytes only through short-lived presigned URLs.
//
// VIDEO playback: a <video> element issues many byte-range GETs against the
// SAME URL over the whole playback, so the TTL comfortably exceeds any
// realistic presentation (6 h); the client also re-fetches on demand.
//
// FONT bytes: fetched ONCE by FontFace.load(); the URL only needs to be
// valid at fetch time. 1 h is ample.
export const VIDEO_PLAYBACK_URL_TTL_SEC = Number(
  process.env['MEDIA_VIDEO_URL_TTL_SEC'] ?? 6 * 60 * 60,
)
export const FONT_URL_TTL_SEC = Number(process.env['MEDIA_FONT_URL_TTL_SEC'] ?? 60 * 60)

export const IMAGE_VARIANTS: readonly ImageVariant[] = ['thumb', 'preview', 'display', 'original']

export function isImageVariant(v: string): v is ImageVariant {
  return (IMAGE_VARIANTS as readonly string[]).includes(v)
}

/** The largest file any media upload may be — what received bytes of unknown kind are capped at. */
const MAX_ANY_UPLOAD = Math.max(MAX_IMAGE_UPLOAD_SIZE, MAX_VIDEO_UPLOAD_SIZE, MAX_FONT_UPLOAD_SIZE)

/**
 * Largest video the server fetches from a URL (or decodes from base64) on a
 * caller's behalf, below the 500 MB browser upload limit. Videos by URL are
 * capped rather than refused: the download streams to a temporary file and
 * from there to the bucket, so its size costs disk and time, not memory —
 * and stock clips an agent finds on the web are usually well under 200 MB.
 * Anything larger goes through the resumable tus upload.
 */
export const MAX_REMOTE_VIDEO_BYTES = Math.min(MAX_VIDEO_UPLOAD_SIZE, 200_000_000)

/** The limit of a URL / base64 upload of a kind (images and fonts: the same as a browser upload). */
export function maxRemoteUploadBytes(kind: UploadKind): number {
  if (kind === 'video') return MAX_REMOTE_VIDEO_BYTES
  return maxUploadBytes(kind)
}

/** What a URL / base64 download of unknown kind is capped at. */
const MAX_ANY_REMOTE_UPLOAD = Math.max(
  maxRemoteUploadBytes('image'),
  maxRemoteUploadBytes('video'),
  maxRemoteUploadBytes('font'),
)

/** Bytes read from the start of a file to sniff its signature (sniffMime reads ≤ 512). */
const SNIFF_BYTES = 4096

export function createMediaService(deps: ServiceDeps): MediaService {
  const { db } = deps

  async function requireDeckRole(
    deckId: string | null,
    userId: string | null,
    shareToken: string | null | undefined,
    required: 'viewer' | 'owner',
  ): Promise<void> {
    const access = await resolveDeckAccess(db, {
      deckId: deckId ?? '',
      userId,
      shareToken: shareToken ?? null,
    })
    if (!access || !roleAtLeast(access.role, required)) {
      throw forbidden(required === 'owner' ? 'Forbidden: owner role required' : 'Forbidden')
    }
  }

  async function upload(args: {
    userId: string
    deckId: string
    source: BinarySource
  }): Promise<MediaUploadResult> {
    const { userId, deckId, source } = args
    const remote = source.kind !== 'bytes'
    // Cap the read by the declared kind when there is one, else by the
    // largest kind; the exact per-kind limit is re-checked once the bytes
    // say what they are.
    const hinted = classifyUpload(source.mimeType ?? '', source.filename)
    return withBinarySource(
      source,
      {
        userId,
        maxBytes: hinted === null ? MAX_ANY_UPLOAD : maxUploadBytes(hinted),
        maxRemoteBytes: hinted === null ? MAX_ANY_REMOTE_UPLOAD : maxRemoteUploadBytes(hinted),
        what: 'The media file',
        timeoutMs: LARGE_DOWNLOAD_TIMEOUT_MS,
      },
      async (file) => {
        // What the bytes are beats what anyone declared; the declared type
        // only decides when the signature is not one we recognise (e.g. a
        // video container we do not sniff). The finalize step still
        // magic-checks rasters.
        const mimeType = sniffMime(await file.head(SNIFF_BYTES)) ?? file.mimeType
        const kind = classifyUpload(mimeType, file.filename)
        if (kind === null) {
          throw unsupportedType(
            `Unsupported media type: ${mimeType || 'unknown'}. Only image/*, video/*, and font files are accepted.`,
          )
        }
        if (remote && file.sizeBytes > maxRemoteUploadBytes(kind)) {
          throw tooLarge(
            `${kind === 'video' ? 'Video' : kind === 'image' ? 'Image' : 'Font'} by URL or base64 ` +
              `exceeds ${maxRemoteUploadBytes(kind)} bytes; upload larger files with the tus upload instead.`,
          )
        }
        if (file.sizeBytes > maxUploadBytes(kind)) throw tooLarge(tooLargeMessage(kind))
        return storeAndFinalize({ userId, deckId, file, mimeType, kind })
      },
    )
  }

  /** Put the file in the bucket (streamed) and run the shared finalize step. */
  async function storeAndFinalize(args: {
    userId: string
    deckId: string
    file: BinaryFile
    mimeType: string
    kind: UploadKind
  }): Promise<MediaUploadResult> {
    const { userId, deckId, file, mimeType, kind } = args
    const assetId = nanoid(16)
    const ext = extensionFromMimeOrFilename(mimeType, file.filename)
    const folder = kind === 'font' ? 'fonts' : 'uploads'
    const storageKey = `decks/${deckId}/${folder}/${assetId}/original.${ext}`
    const s3 = buildS3Client()
    await s3.send(
      new PutObjectCommand({
        Bucket: MEDIA_BUCKET,
        Key: storageKey,
        // Streamed from the temporary file of a URL download; the length is
        // required for a stream body.
        Body: file.stream(),
        ContentLength: file.sizeBytes,
        ContentType: mimeType,
      }),
    )

    let finalized
    try {
      finalized = await finalizeMediaUpload({
        db,
        s3,
        storageKey,
        assetId,
        deckId,
        userId,
        mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        log: deps.log,
      })
    } catch (err) {
      if (err instanceof UploadRejected) {
        throw new ServiceError(
          err.status >= 500 ? 'failed' : 'invalid_input',
          err.status,
          err.message,
        )
      }
      throw err
    }

    if (finalized.kind === 'font') {
      return {
        assetId,
        kind: 'font',
        mimeType,
        sizeBytes: finalized.sizeBytes,
        width: null,
        height: null,
        font: {
          family: finalized.fontFamily,
          weight: finalized.fontWeight,
          style: finalized.fontStyle,
          postscriptName: finalized.fontPostscriptName,
        },
      }
    }
    if (finalized.kind === 'video') {
      return {
        assetId,
        kind: 'video',
        mimeType,
        sizeBytes: finalized.sizeBytes,
        width: null,
        height: null,
        transcodeStatus: 'pending',
      }
    }
    return {
      assetId,
      kind: 'image',
      mimeType,
      sizeBytes: finalized.sizeBytes,
      width: finalized.width,
      height: finalized.height,
    }
  }

  async function videoInfo(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    deckId?: string | undefined
  }): Promise<VideoInfo> {
    const asset = await getVideoAsset(db, args.assetId)
    if (!asset || (args.deckId !== undefined && asset.deckId !== args.deckId)) {
      throw notFound('Video asset not found')
    }
    await requireDeckRole(asset.deckId, args.userId, args.shareToken, 'viewer')

    const posterUrl = asset.posterKey
      ? signImgproxyUrl({ storageKey: asset.posterKey, variant: 'display', extension: 'jpg' })
      : null
    const thumbnailUrl = asset.thumbnailKey
      ? signImgproxyUrl({ storageKey: asset.thumbnailKey, variant: 'thumb', extension: 'jpg' })
      : null
    // Progressive MP4: short-TTL presigned URL (MEDIA-1, private bucket).
    // MinIO serves byte-range requests against it, so a plain <video> seeks.
    const playbackUrl = asset.playbackKey
      ? await presignGetUrl(asset.playbackKey, VIDEO_PLAYBACK_URL_TTL_SEC)
      : null

    return {
      assetId: asset.id,
      transcodeStatus: asset.transcodeStatus,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      posterUrl,
      thumbnailUrl,
      playbackUrl,
      transcodeError: asset.transcodeError ?? null,
    }
  }

  async function url(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    variant: ImageVariant
    deckId?: string | undefined
  }): Promise<{ url: string }> {
    const asset = await getMediaAsset(db, args.assetId)
    if (!asset || (args.deckId !== undefined && asset.deckId !== args.deckId)) {
      throw notFound('Asset not found')
    }
    await requireDeckRole(asset.deckId, args.userId, args.shareToken, 'viewer')
    return { url: signImgproxyUrl({ storageKey: asset.storageKey, variant: args.variant }) }
  }

  async function fontUrl(args: {
    userId: string
    assetId: string
    folderId?: string | undefined
  }): Promise<FontUrlInfo> {
    const asset = await getFontAsset(db, args.assetId)
    if (!asset || (args.folderId !== undefined && asset.folderId !== args.folderId)) {
      throw notFound('Font asset not found')
    }
    // Legacy deck-scoped row (should have been migrated by 0009): no caller expects it.
    if (!asset.folderId) throw notFound('Font asset is not folder-scoped')
    await requireOwnedFolder(db, asset.folderId, args.userId)
    return {
      assetId: asset.id,
      url: await presignGetUrl(asset.storageKey, FONT_URL_TTL_SEC),
      family: asset.fontFamily,
      weight: asset.fontWeight,
      style: asset.fontStyle,
      postscriptName: asset.fontPostscriptName,
      mimeType: asset.mimeType,
    }
  }

  async function remove(args: {
    userId: string
    assetId: string
    deckId?: string | undefined
  }): Promise<void> {
    const asset = await getMediaAsset(db, args.assetId)
    if (!asset || (args.deckId !== undefined && asset.deckId !== args.deckId)) {
      throw notFound('Asset not found')
    }
    await requireDeckRole(asset.deckId, args.userId, null, 'owner')
    // NOTE: the MinIO object remains — see TODO(M29) for the GC job.
    await deleteMediaAsset(db, args.assetId)
  }

  return { upload, videoInfo, url, fontUrl, delete: remove }
}
