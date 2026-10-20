/**
 * services/media.ts — server implementation of `MediaService`
 * (packages/commands/src/services/media.ts). The /api/media routes and the
 * `media.*` commands call these functions; uploads go through the same
 * finalize step as the tus upload (media/finalizeUpload.ts) and the same
 * policy (media/uploadPolicy.ts).
 *
 * Per-asset reads and removals follow the asset's owner (media/mediaOwner.ts):
 * a deck's media by the deck role (a share link reads); a component
 * master's or a folder's pictures and videos are read by whoever may read
 * the folder's content (a deck guest and a share link included, so linked
 * media shows on a shared deck). Removing follows `remove`: a master's
 * media is handed to its folder by a folder editor, the folder's own is
 * deleted by the folder owner only.
 */

import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type {
  BinarySource,
  FontUrlInfo,
  ImageVariant,
  MediaDeleteOutcome,
  MediaOwnerRef,
  MediaService,
  MediaUploadResult,
  UploadSessionInfo,
  VideoInfo,
} from '@narrative/commands'
import { components, mediaAssets } from '../db/schema.js'
import { deleteMediaAsset, getFontAsset, getMediaAsset, getVideoAsset } from '../media/assets.js'
import { purgeUnreferencedKeys } from '../media/bucketCleanup.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { buildS3Client, MEDIA_BUCKET, presignGetUrl } from '../media/s3Client.js'
import {
  COMPONENT_FONT_REFUSED,
  finalizeMediaUpload,
  UploadRejected,
} from '../media/finalizeUpload.js'
import {
  canReadComponentMedia,
  canWriteComponentMedia,
  mediaOriginalPath,
  type MediaOwner,
} from '../media/mediaOwner.js'
import { folderOfOwner, visibleIn } from '../media/visibleMedia.js'
import {
  classifyUpload,
  extensionFromMimeOrFilename,
  maxUploadBytes,
  mimeFromFilename,
  MAX_FONT_UPLOAD_SIZE,
  MAX_IMAGE_UPLOAD_SIZE,
  MAX_VIDEO_UPLOAD_SIZE,
  sniffMime,
  tooLargeMessage,
  type UploadKind,
} from '../media/uploadPolicy.js'
import {
  resolveDeckAccess,
  resolveFolderAccess,
  resolveFolderContentAccess,
  roleAtLeast,
} from '../auth/permissions.js'
import type { ServiceDeps } from './deps.js'
import {
  ServiceError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooLarge,
  unsupportedType,
} from './errors.js'
import { bypassAliases, folderRoleRefusal, requireFolderContentReader } from './shared.js'
import { UploadSessionLimitError } from '../media/uploadSessions.js'
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

  /**
   * The caller may read the asset: a component master's or a folder's
   * picture or video (a deleted component's, handed to its folder) by
   * whoever may read the folder's content — a member, or anyone with access
   * to one of the folder's decks, a share link included, so a linked picture
   * shows on a shared deck; a deck's asset by the deck role, share links
   * included, as always. Who may remove an asset is `remove`'s.
   */
  async function requireAssetReader(
    asset: { deckId: string | null; componentId?: string | null; folderId?: string | null },
    userId: string | null,
    shareToken: string | null | undefined,
  ): Promise<void> {
    const componentId = asset.componentId ?? null
    if (componentId !== null) {
      if (!(await canReadComponentMedia(db, componentId, userId, shareToken))) {
        throw forbidden('Forbidden')
      }
      return
    }
    const folderId = asset.deckId === null ? (asset.folderId ?? null) : null
    if (folderId !== null) {
      const access = await resolveFolderContentAccess(db, {
        folderId,
        userId,
        shareToken: shareToken ?? null,
      })
      if (access === null) throw forbidden('Forbidden')
      return
    }
    await requireDeckRole(asset.deckId, userId, shareToken, 'viewer')
  }

  /**
   * Whether `asset` is `owner`'s own (any owner when none is named). Deleting
   * goes by this, never by what the owner may show: a linked picture belongs
   * to its master or folder, and removing it would empty every slide that
   * links it.
   */
  function ownedBy(
    asset: { deckId: string | null; componentId?: string | null },
    owner: MediaOwner | undefined,
  ): boolean {
    if (owner === undefined) return true
    return 'componentId' in owner
      ? asset.componentId === owner.componentId
      : asset.deckId === owner.deckId && (asset.componentId ?? null) === null
  }

  /**
   * Whether `owner` (a deck or a master an agent names) may show `asset`:
   * its own, or — linked — its folder's components' and the folder's own
   * (media/visibleMedia.ts). Any asset when no owner is named.
   */
  async function shownBy(
    asset: {
      deckId: string | null
      componentId?: string | null
      folderId?: string | null
      kind: 'image' | 'video' | 'font'
    },
    owner: MediaOwner | undefined,
  ): Promise<boolean> {
    if (owner === undefined) return true
    const componentId = asset.componentId ?? null
    const [ownerFolder, componentFolder] = await Promise.all([
      folderOfOwner(db, owner),
      componentId === null ? null : folderOfOwner(db, { componentId }),
    ])
    return visibleIn(
      {
        deckId: asset.deckId,
        componentId,
        folderId: asset.folderId ?? null,
        componentFolderId: componentFolder,
        kind: asset.kind,
      },
      { owner, folderId: ownerFolder },
    )
  }

  async function upload(args: {
    userId: string
    owner: MediaOwner
    source: BinarySource
  }): Promise<MediaUploadResult> {
    const { userId, owner, source } = args
    // A deck's editor role is the caller's to check (the host, the routes);
    // a master's media is its folder editors', as its document is.
    if ('componentId' in owner && !(await canWriteComponentMedia(db, owner.componentId, userId))) {
      throw notFound('Component not found')
    }
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
        if (kind === 'font' && 'componentId' in owner) {
          // Refused before anything is stored; finalizeUpload refuses it too.
          throw unsupportedType(COMPONENT_FONT_REFUSED)
        }
        return storeAndFinalize({ userId, owner, file, mimeType, kind })
      },
    )
  }

  /** Put the file in the bucket (streamed) and run the shared finalize step. */
  async function storeAndFinalize(args: {
    userId: string
    owner: MediaOwner
    file: BinaryFile
    mimeType: string
    kind: UploadKind
  }): Promise<MediaUploadResult> {
    const { userId, owner, file, mimeType, kind } = args
    const assetId = nanoid(16)
    const ext = extensionFromMimeOrFilename(mimeType, file.filename)
    const folder = kind === 'font' ? 'fonts' : 'uploads'
    const storageKey = mediaOriginalPath(owner, folder, assetId, ext)
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
        owner,
        userId,
        mimeType,
        filename: file.filename,
        sizeBytes: file.sizeBytes,
        log: deps.log,
        // Only agents upload through this service (media.upload): the bytes
        // must prove their type (finalizeUpload.ts).
        strictContent: true,
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
    owner?: MediaOwner | undefined
  }): Promise<VideoInfo> {
    const asset = await getVideoAsset(db, args.assetId)
    if (!asset || !(await shownBy({ ...asset, kind: 'video' }, args.owner))) {
      throw notFound('Video asset not found')
    }
    await requireAssetReader(asset, args.userId, args.shareToken)

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
    // The 1080p rendition of a larger video (P3): present mode picks it when
    // the slide is shown at 1080p or less; null when there is none.
    const presentPlayback =
      asset.playbackKey !== null &&
      asset.presentPlaybackKey !== null &&
      asset.presentWidth !== null &&
      asset.presentHeight !== null
        ? {
            url: await presignGetUrl(asset.presentPlaybackKey, VIDEO_PLAYBACK_URL_TTL_SEC),
            width: asset.presentWidth,
            height: asset.presentHeight,
          }
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
      presentPlayback,
      transcodeError: asset.transcodeError ?? null,
    }
  }

  async function url(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    variant: ImageVariant
    owner?: MediaOwner | undefined
  }): Promise<{ url: string }> {
    const asset = await getMediaAsset(db, args.assetId)
    if (!asset || !(await shownBy(asset, args.owner))) {
      throw notFound('Asset not found')
    }
    await requireAssetReader(asset, args.userId, args.shareToken)
    return { url: signImgproxyUrl({ storageKey: asset.storageKey, variant: args.variant }) }
  }

  async function fontUrl(args: {
    userId: string | null
    shareToken?: string | null | undefined
    assetId: string
    folderId?: string | undefined
  }): Promise<FontUrlInfo> {
    const asset = await getFontAsset(db, args.assetId)
    if (!asset || (args.folderId !== undefined && asset.folderId !== args.folderId)) {
      throw notFound('Font asset not found')
    }
    // Legacy deck-scoped row (should have been migrated by 0009): no caller expects it.
    if (!asset.folderId) throw notFound('Font asset is not folder-scoped')
    // A deck guest loads its folder's fonts too, a share-link visitor
    // included: the deck renders with them.
    await requireFolderContentReader(db, asset.folderId, args.userId, {
      bypass: deps.bypass,
      shareToken: args.shareToken,
    })
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

  /** The caller's role in a folder (BYPASS_AUTH counts the legacy demo user too), or null. */
  async function folderRole(folderId: string, userId: string) {
    if (userId === '') return null
    const access = await resolveFolderAccess(db, {
      folderId,
      userId,
      alsoAs: bypassAliases(userId, deps.bypass),
    })
    return access?.role ?? null
  }

  /**
   * Remove an asset from its owner's media (MediaService.delete):
   *
   *   - a component master's picture or video is detached from the master
   *     and handed to its folder — `component_id = NULL, folder_id =
   *     folder`, as deleting the component does — so the stamps that link it
   *     keep showing it; the master no longer owns it. An editor of the
   *     folder may (the right to change the master).
   *   - a folder's own picture or video (a deleted component's, or one
   *     handed over as above) may be linked by any deck of the folder:
   *     only the folder's owner deletes it (or deleting the folder does).
   *   - a folder font is not removed here: `DELETE /api/folders/:id/fonts/
   *     :assetId` (folder.fonts.delete) keeps the decks that use it
   *     rendering, which a bare row delete would not.
   *   - a deck's asset: the deck's owner.
   *
   * `owner`, when named (an agent's target), must be the asset's owner: a
   * deck, a master, or the folder for its own media. A deleted row's stored
   * files go too, unless another row still names them
   * (media/bucketCleanup.ts).
   */
  async function remove(args: {
    userId: string
    assetId: string
    owner?: MediaOwnerRef | undefined
  }): Promise<{ outcome: MediaDeleteOutcome }> {
    const asset = await getMediaAsset(db, args.assetId)
    const owner = args.owner
    const owned =
      asset !== null &&
      (owner !== undefined && 'folderId' in owner
        ? asset.deckId === null &&
          (asset.componentId ?? null) === null &&
          asset.folderId === owner.folderId
        : ownedBy(asset, owner))
    if (!asset || !owned) {
      throw notFound('Asset not found')
    }

    const componentId = asset.componentId ?? null
    const folderId = asset.deckId === null ? (asset.folderId ?? null) : null
    if (componentId !== null) {
      const [component] = await db
        .select({ folderId: components.folderId })
        .from(components)
        .where(eq(components.id, componentId))
        .limit(1)
      if (!component) throw notFound('Asset not found')
      const role = await folderRole(component.folderId, args.userId)
      if (role === null) throw forbidden('Forbidden')
      if (!roleAtLeast(role, 'editor')) throw forbidden(folderRoleRefusal('editor'))
      const [handed] = await db
        .update(mediaAssets)
        .set({ componentId: null, folderId: component.folderId })
        .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.componentId, componentId)))
        .returning({ id: mediaAssets.id })
      if (!handed) throw conflict('The asset changed while it was being removed; try again')
      return { outcome: 'handedToFolder' }
    }

    if (folderId !== null) {
      // Say nothing about the folder's media to someone who cannot see it.
      const reader = await resolveFolderContentAccess(db, {
        folderId,
        userId: args.userId === '' ? null : args.userId,
        shareToken: null,
        alsoAs: bypassAliases(args.userId, deps.bypass),
      })
      if (reader === null) throw forbidden('Forbidden')
      if (asset.kind === 'font') {
        throw badRequest(
          `Asset '${asset.id}' is a font of its folder: remove it with ` +
            `DELETE /api/folders/${folderId}/fonts/${asset.id} (folder.fonts.delete), ` +
            'which keeps the decks that use it rendering',
        )
      }
      if ((await folderRole(folderId, args.userId)) !== 'owner') {
        throw forbidden(
          "Forbidden: a picture or video the folder owns may be linked by any of its decks; only the folder's " +
            'owner may delete it',
        )
      }
    } else {
      await requireDeckRole(asset.deckId, args.userId, null, 'owner')
    }

    const keys = [
      asset.storageKey,
      asset.playbackKey,
      asset.posterKey,
      asset.thumbnailKey,
      asset.presentPlaybackKey,
    ].filter((k): k is string => typeof k === 'string' && k !== '')
    const deletedKeys = await deleteMediaAsset(db, asset.id)
    await purgeUnreferencedKeys(db, [...new Set([...keys, ...deletedKeys])], deps.log)
    return { outcome: 'deleted' }
  }

  async function openUploadSession(args: {
    userId: string
    owner: MediaOwner
    filename: string
    mimeType?: string | undefined
    sizeBytes: number
    credentialKey?: string | undefined
  }): Promise<UploadSessionInfo> {
    const { owner } = args
    if ('componentId' in owner) {
      if (!(await canWriteComponentMedia(db, owner.componentId, args.userId))) {
        throw notFound('Component not found')
      }
    } else {
      const access = await resolveDeckAccess(db, {
        deckId: owner.deckId,
        userId: args.userId,
        shareToken: null,
      })
      if (!access) throw notFound('Deck not found')
      if (!roleAtLeast(access.role, 'editor')) {
        throw forbidden('Uploading into this deck needs editor access')
      }
    }
    const mimeType = args.mimeType ?? mimeFromFilename(args.filename)
    if (mimeType === null) {
      throw unsupportedType(
        `Cannot tell the type of '${args.filename}' from its extension; give mimeType (image/*, video/* or a font)`,
      )
    }
    const kind = classifyUpload(mimeType, args.filename)
    if (kind === null) {
      throw unsupportedType(
        `Unsupported media type: ${mimeType}. An upload session takes images, videos and fonts.`,
      )
    }
    if (kind === 'font' && 'componentId' in owner) throw unsupportedType(COMPONENT_FONT_REFUSED)
    if (!Number.isInteger(args.sizeBytes) || args.sizeBytes < 1) {
      throw badRequest('sizeBytes must be the size of the file in bytes')
    }
    if (args.sizeBytes > maxUploadBytes(kind)) throw tooLarge(tooLargeMessage(kind))
    if (deps.apiBaseUrl === undefined || deps.uploadSessions === undefined) {
      throw new ServiceError('failed', 500, 'Upload sessions are not configured on this server')
    }
    let issued
    try {
      issued = await deps.uploadSessions.issue({
        userSub: args.userId,
        owner,
        sizeBytes: args.sizeBytes,
        kind,
        credentialKey: args.credentialKey,
      })
    } catch (err) {
      if (err instanceof UploadSessionLimitError) {
        throw new ServiceError('conflict', 429, err.message)
      }
      throw err
    }
    const { token, expiresAt } = issued
    const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64')
    return {
      url: `${deps.apiBaseUrl.replace(/\/+$/, '')}/api/uploads`,
      token,
      expiresAt: expiresAt.toISOString(),
      uploadMetadata: [
        'componentId' in owner
          ? `componentId ${b64(owner.componentId)}`
          : `deckId ${b64(owner.deckId)}`,
        `filename ${b64(args.filename)}`,
        `content-type ${b64(mimeType)}`,
      ].join(','),
      kind,
      mimeType,
      sizeBytes: args.sizeBytes,
    }
  }

  return { upload, videoInfo, url, fontUrl, delete: remove, openUploadSession }
}
