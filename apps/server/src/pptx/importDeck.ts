/**
 * pptx/importDeck.ts
 *
 * Shared "import a `.pptx` Buffer as a new deck" pipeline. Extracted so
 * the two upload paths can converge on the same logic:
 *   1. `POST /folders/:folderId/import-pptx` — synchronous buffered POST
 *      (the original M28 endpoint, kept for backward compat).
 *   2. tus-based chunked upload — the new path that streams the bytes
 *      into MinIO first, then calls this from `onUploadFinish` after
 *      reading them back as a Buffer.
 *
 * Steps:
 *   - Verify the editor role in the folder.
 *   - Parse pptx via `parsePptx`.
 *   - Upload every embedded image / video to MinIO under the new deck's
 *     namespace, patching the parsed shapes' `assetId` fields.
 *   - Build a Y.Doc state buffer via `buildDeckUpdate`.
 *   - `registerDeckMedia`: insert deck + permission + deck_updates +
 *     media_assets in one tx, then enqueue a transcode per video once it has
 *     committed. The append path (`appendDeck.ts`) registers its media
 *     through the same function, so the two cannot drift apart again.
 *
 * The function is loader-friendly: callers pass their own logger so the
 * tus path can use `fastify.log`'s child logger while the route path uses
 * `request.log`. Returns the same result shape both paths surface to the
 * client (matches `apps/web/src/api/client.ts:ImportPptxResult`).
 */

import type { PlaceholderHints } from './writer.js'
import { createRequire } from 'node:module'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { eq, inArray, TransactionRollbackError } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { decks, deckPermissions, deckUpdates, folders, mediaAssets } from '../db/schema.js'
import { resolveFolderAccess, roleAtLeast } from '../auth/permissions.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { enqueueVideoTranscode } from '../media/enqueue.js'
import type { MediaOwner } from '../media/mediaOwner.js'
import { purgeExplicitKeys } from '../media/bucketCleanup.js'
import { parseFontMetadata } from '../media/fontMetadata.js'
import { downscaleForStorage, exceedsStoredImageLimits } from '../media/storedImageLimits.js'
import { parsePptx, type ParsedPptx } from './parser.js'
import { buildDeckUpdate } from './writer.js'
import { endPhase } from './phases.js'
import { mapConcurrent, WeightedSemaphore } from '../lib/concurrency.js'
import { sanitizeFontFamily } from '@narrative/slide-model'

const require = createRequire(import.meta.url)
interface ProbeResult {
  width: number
  height: number
  type: string
}
/**
 * The synchronous prober: it reads only the header, from a buffer we hold
 * anyway. The stream prober runs every format's parser over the whole
 * stream, and its SVG parser turns each chunk — here the whole picture —
 * into a string first: 3 s of blocked event loop per 200 pictures.
 */
const probeImageSize: (buffer: Buffer) => ProbeResult | null = require('probe-image-size/sync')

/**
 * Embedded files read, downscaled and uploaded at once. The work is the
 * object store's round trips and sharp on libuv's pool (4 threads unless
 * UV_THREADPOOL_SIZE says otherwise); six in flight keep both busy without
 * holding more than six pictures' bytes. Measured with `just perf-pptx`
 * (docs/plans/performance.md, X1).
 */
export const IMPORT_MEDIA_CONCURRENCY = 6

/**
 * Pixels of oversize pictures (media/storedImageLimits.ts) being downscaled
 * at once. Decoding and re-encoding one costs a few bytes per pixel, and six
 * of them at once (a deck of 96, 75, 47, 46 and 46 MP photos) took the peak
 * RSS from 1.1 GB to 2 GB; under this budget two 46 MP pictures still share,
 * a 96 MP one runs alone, and the small pictures keep every lane meanwhile.
 */
export const OVERSIZE_PIXEL_BUDGET = 100_000_000

/** Minimal logger surface that both Fastify request loggers and the
 *  Fastify app logger satisfy — accepts `(obj, msg)` like pino. */
export interface ImportLogger {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
}

/**
 * Standard result shape — kept in sync with `ImportPptxResult` on the
 * client side. Both upload paths surface this to the user.
 */
export interface ImportDeckResult {
  deckId: string
  slideCount: number
  objectsCreated: number
  skipped: { images: number; unknownShapes: number; fonts: number }
  ignoredElements: string[]
  slideWidth: number
  slideHeight: number
  /** Number of embedded fonts (typeface × variant) lifted from the
   *  PPTX's `<p:embeddedFontLst>` and stamped into `media_assets`. */
  embeddedFontCount: number
  /** Distinct `fontFamily` values referenced anywhere in the imported
   *  deck (text frames, table defaults, per-cell + per-run overrides).
   *  Filters out OOXML theme placeholders (`+mn-lt` / `+mj-lt`) and
   *  empty strings. The post-import dialog reads this against the
   *  list of fonts already available (system + embedded + folder) to
   *  surface a "fonts referenced but missing" upload prompt. */
  referencedFontFamilies: string[]
  /** Per slide, the placeholder each object filled (writer.ts PlaceholderHints). */
  placeholders?: PlaceholderHints
}

/**
 * Failure outcome — kept as a discriminated union so callers can map
 * each kind to the right HTTP status code (404 for folder-not-found,
 * 403 for forbidden, 400 for parse failure, etc.). Throwing exceptions
 * across the tus / route boundary is messy because tus only surfaces
 * a body string; returning a structured result lets each caller format
 * the error in its native shape.
 */
export type ImportDeckError =
  | { kind: 'folderNotFound' }
  | { kind: 'forbidden' }
  | { kind: 'emptyBody' }
  | { kind: 'parseFailed'; message: string }
  | { kind: 'noSlides' }
  | { kind: 'deckInsertFailed' }

/**
 * Run the full "buffer → deck" pipeline. Pure server side; no HTTP
 * primitives. Caller is responsible for surfacing the result / error
 * over the right transport.
 */
export async function importDeckFromPptxBytes(args: {
  bytes: Buffer
  folderId: string
  ownerUserId: string
  filenameForTitle?: string
  db: Database
  log: ImportLogger
  /** Queues a video's transcode (default: the BullMQ queue; see `registerOwnedMedia`). */
  enqueueVideo?: VideoEnqueuer
}): Promise<{ ok: true; result: ImportDeckResult } | { ok: false; error: ImportDeckError }> {
  const { bytes, folderId, ownerUserId, filenameForTitle, db, log, enqueueVideo } = args

  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'emptyBody' } }
  }

  // A new deck goes into a folder the user may change (editor), checked
  // before the expensive parse.
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)
  if (!folder) return { ok: false, error: { kind: 'folderNotFound' } }
  const access = await resolveFolderAccess(db, { folderId, userId: ownerUserId })
  if (access === null || !roleAtLeast(access.role, 'editor')) {
    return { ok: false, error: { kind: 'forbidden' } }
  }
  endPhase('import', 'access')

  let parsed: ParsedPptx
  try {
    parsed = await parsePptx(bytes)
  } catch (err) {
    log.warn({ err }, 'pptx-import: parse failed')
    return {
      ok: false,
      error: {
        kind: 'parseFailed',
        message: err instanceof Error ? err.message : 'unknown error',
      },
    }
  }
  if (parsed.slides.length === 0) {
    return { ok: false, error: { kind: 'noSlides' } }
  }

  const deckId = nanoid(12)
  const title = deriveTitle(filenameForTitle)
  const now = new Date()

  const media = await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, log)
  const { uploadedImageCount, skippedUnsupportedImages, uploadedFontCount, skippedFontCount } =
    media

  const { state, slideCount, objectsCreated, skipped, placeholders } = buildDeckUpdate(parsed)
  endPhase('import', 'build')

  // The deck, its owner grant and its first document state commit in the
  // same transaction as the media rows — the rows reference the deck, and a
  // deck whose document points at rows that never landed must not exist.
  try {
    await registerDeckMedia({
      db,
      deckId,
      ownerUserId,
      media,
      log,
      ...(enqueueVideo !== undefined ? { enqueueVideo } : {}),
      alongside: async (tx) => {
        const [deck] = await tx
          .insert(decks)
          .values({
            id: deckId,
            title,
            ownerUserId,
            folderId,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
        if (!deck) tx.rollback()

        await tx.insert(deckPermissions).values({
          deckId,
          userId: ownerUserId,
          role: 'owner',
          grantedAt: now,
          grantedBy: ownerUserId,
        })

        await tx.insert(deckUpdates).values({
          deckId,
          update: state,
          createdAt: now,
        })
      },
    })
  } catch (err) {
    if (err instanceof TransactionRollbackError) {
      return { ok: false, error: { kind: 'deckInsertFailed' } }
    }
    throw err
  }
  endPhase('import', 'store')

  // Walk the parsed shapes once to gather every font-family that any
  // text / table / run references. This drives the "missing fonts"
  // upload panel in the post-import dialog — the client compares this
  // list against the deck's font registry (system + embedded fonts
  // we just uploaded + already-uploaded folder fonts) and prompts the
  // user to provide any face that's still unavailable.
  const referencedFontFamilies = collectReferencedFontFamilies(parsed)

  log.info(
    {
      deckId,
      slideCount,
      objectsCreated,
      skippedImages: skipped.images + skippedUnsupportedImages,
      skippedUnknown: skipped.unknownShapes,
      uploadedImages: uploadedImageCount,
      uploadedFonts: uploadedFontCount,
      skippedFonts: skippedFontCount,
      referencedFonts: referencedFontFamilies.length,
      ignored: parsed.ignoredElements,
    },
    'pptx-import: deck created',
  )

  return {
    ok: true,
    result: {
      deckId,
      slideCount,
      objectsCreated,
      skipped: {
        images: skipped.images + skippedUnsupportedImages,
        unknownShapes: skipped.unknownShapes,
        fonts: skippedFontCount,
      },
      ignoredElements: parsed.ignoredElements,
      slideWidth: parsed.slideWidth,
      slideHeight: parsed.slideHeight,
      embeddedFontCount: uploadedFontCount,
      referencedFontFamilies,
      ...(placeholders.length > 0 ? { placeholders } : {}),
    },
  }
}

/** Queues one video's HLS transcode; `enqueueVideoTranscode` unless a caller swaps it. */
export type VideoEnqueuer = typeof enqueueVideoTranscode

/** A Drizzle transaction handle, as `db.transaction` hands it to its callback. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * A parsed deck's embedded media after `uploadEmbeddedImagesAndPatchAssetIds`:
 * the bytes are in MinIO and the parsed shapes point at the new asset ids, but
 * no `media_assets` row exists yet and no transcode has been asked for.
 */
export type StagedDeckMedia = Awaited<ReturnType<typeof uploadEmbeddedImagesAndPatchAssetIds>>

/**
 * Register a parsed deck's staged media — THE one code path for it, shared by
 * the new-deck import and the append into an existing deck.
 *
 *   1. One transaction: `alongside` first (it may create the deck the rows
 *      reference), then every `media_assets` row.
 *   2. Only after that commits: one HLS transcode job per video. Enqueuing
 *      earlier would let the worker pick up a job for a row that does not
 *      exist yet; not enqueuing at all leaves the row `pending` forever — the
 *      bug the append path had while it carried its own copy of step 1.
 *
 * A failed enqueue is logged and swallowed, the same policy as the tus video
 * branch: the row is durable, and `db:backfill-video` re-enqueues it.
 *
 * Throws when the transaction fails; nothing is registered in that case (the
 * uploaded bytes are the caller's to discard — see `discardDeckMedia`).
 * Returns whatever `alongside` returned.
 */
export async function registerDeckMedia<T = void>(args: {
  db: Database
  deckId: string
  ownerUserId: string
  media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'>
  log: ImportLogger
  /** Writes that must commit atomically with the media rows. */
  alongside?: (tx: DbTransaction) => Promise<T>
  enqueueVideo?: VideoEnqueuer
}): Promise<T | undefined> {
  const { deckId, ...rest } = args
  return registerOwnedMedia({ ...rest, owner: { deckId } })
}

/**
 * `registerDeckMedia` for any owner of the rows — a deck, or a component
 * master (A2.12b). A component's videos are enqueued without a deck: the
 * worker takes the output prefix from the storage key.
 */
export async function registerOwnedMedia<T = void>(args: {
  db: Database
  owner: MediaOwner
  ownerUserId: string
  media: Pick<StagedDeckMedia, 'mediaAssetRows' | 'videoTranscodeJobs'>
  log: ImportLogger
  /** Writes that must commit atomically with the media rows. */
  alongside?: (tx: DbTransaction) => Promise<T>
  /**
   * Queues each video's transcode after the commit. Production leaves it at
   * the BullMQ queue; the performance driver swaps in a counter so measuring
   * never hands jobs to a worker of the shared dev stack.
   */
  enqueueVideo?: VideoEnqueuer
}): Promise<T | undefined> {
  const { db, owner, ownerUserId, media, log, alongside } = args
  const enqueue = args.enqueueVideo ?? enqueueVideoTranscode

  const result = await db.transaction(async (tx) => {
    const r = alongside !== undefined ? await alongside(tx) : undefined
    if (media.mediaAssetRows.length > 0) {
      await tx.insert(mediaAssets).values(media.mediaAssetRows)
    }
    return r
  })

  for (const job of media.videoTranscodeJobs) {
    try {
      await enqueue({
        assetId: job.assetId,
        ...('deckId' in owner ? { deckId: owner.deckId } : {}),
        storageKey: job.storageKey,
        uploaderUserId: ownerUserId,
        mimeType: job.mimeType,
      })
    } catch (err) {
      log.warn({ err, assetId: job.assetId, ...owner }, 'pptx: enqueueVideoTranscode failed')
    }
  }

  return result
}

/**
 * Undo `uploadEmbeddedImagesAndPatchAssetIds` (+ `registerDeckMedia`, if it
 * got that far) for media that provably nothing references: delete the rows
 * and the stored originals. Only ever call this when no document can hold the
 * asset ids — a row deleted from under a rendered slide is a broken image.
 *
 * Best effort, never throws: whatever survives is deck-scoped, so the deck's
 * ON DELETE CASCADE and `purgeDeckBucketPrefix` still reap it. A transcode
 * job enqueued for a discarded video finds its source gone and fails after
 * its retries, updating zero rows; if it won the race and already fetched the
 * source, its outputs land under `decks/<deckId>/videos/` — the same prefix
 * sweep covers them.
 */
export async function discardDeckMedia(args: {
  db: Database
  deckId: string
  media: Pick<StagedDeckMedia, 'mediaAssetRows'>
  log: ImportLogger
}): Promise<void> {
  const { deckId, ...rest } = args
  await discardOwnedMedia({ ...rest, owner: { deckId } })
}

/**
 * `discardDeckMedia` for any owner of the rows. What survives a failure is
 * reaped with its owner: a deck's by its prefix sweep, a component's
 * (handed to the folder when the component is deleted) by the folder's
 * deletion.
 */
export async function discardOwnedMedia(args: {
  db: Database
  owner: MediaOwner
  media: Pick<StagedDeckMedia, 'mediaAssetRows'>
  log: ImportLogger
}): Promise<void> {
  const { db, owner, media, log } = args
  const ids = media.mediaAssetRows.map((r) => r.id).filter((id): id is string => id !== undefined)
  if (ids.length === 0) return
  try {
    await db.delete(mediaAssets).where(inArray(mediaAssets.id, ids))
  } catch (err) {
    log.warn({ err, ...owner, assetIds: ids }, 'pptx: discarding unreferenced media rows failed')
  }
  const result = await purgeExplicitKeys(
    media.mediaAssetRows.map((r) => r.storageKey),
    {
      warn: (o, m) => log.warn(o, m),
      info: (o, m) => log.info(o, m),
    },
  )
  log.info({ ...owner, assetIds: ids, ...result }, 'pptx: discarded unreferenced media')
}

/**
 * Walk the parsed deck's embedded media (images + videos), upload each
 * to MinIO under the new deck's namespace, and patch the parsed shapes'
 * `assetId` fields so the writer's Y.Doc output points to the right
 * media_assets rows. Unsupported MIME types (e.g. WMF, EMF) are skipped
 * and counted so the caller can surface the loss.
 *
 * Stages only: nothing is written to the database here. Hand the result to
 * `registerDeckMedia`, which both the import and the append path use.
 */
export async function uploadEmbeddedImagesAndPatchAssetIds(
  parsed: ParsedPptx,
  deckId: string,
  ownerUserId: string,
  log: ImportLogger,
): Promise<{
  mediaAssetRows: Array<typeof mediaAssets.$inferInsert>
  uploadedImageCount: number
  skippedUnsupportedImages: number
  uploadedFontCount: number
  skippedFontCount: number
  videoTranscodeJobs: Array<{
    assetId: string
    storageKey: string
    mimeType: string
  }>
}> {
  const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const SUPPORTED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
  const s3 = buildS3Client()
  type MediaRow = typeof mediaAssets.$inferInsert
  type TranscodeJob = { assetId: string; storageKey: string; mimeType: string }

  // Every face and every picture is independent of the others, so they are
  // read, downscaled and uploaded IMPORT_MEDIA_CONCURRENCY at a time. Each
  // task returns its row (or null when it was skipped) and the rows are
  // collected in the deck's order afterwards — the order a serial loop had —
  // so ids, rows and the shapes they patch do not depend on which upload
  // finished first.

  // ─── Embedded fonts ────────────────────────────────────────────────────
  // Walk `<p:embeddedFontLst>` faces first — they're independent of the
  // image/video pipeline and reach the deck via `/api/decks/:id/fonts`
  // (which the editor's FolderFontLoader auto-subscribes to). One
  // media_assets row per (typeface × variant) face. parseFontMetadata
  // is the same opentype.js entry point the tus font-upload route uses;
  // mismatched / corrupt bytes log + skip instead of crashing the
  // entire import.
  const fontRows = await mapConcurrent(
    parsed.embeddedFonts,
    IMPORT_MEDIA_CONCURRENCY,
    async (font): Promise<MediaRow | null> => {
      const assetId = nanoid(12)
      const mimeType = 'font/ttf'
      const storageKey = `decks/${deckId}/fonts/${assetId}/original.${font.ext}`
      let metadata
      try {
        const ab = font.bytes.buffer.slice(
          font.bytes.byteOffset,
          font.bytes.byteOffset + font.bytes.byteLength,
        ) as ArrayBuffer
        metadata = parseFontMetadata(ab)
      } catch (err) {
        log.warn(
          { err, zipPath: font.zipPath, typeface: font.typeface, variant: font.variant },
          'pptx: parseFontMetadata failed, skipping font',
        )
        return null
      }
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: MEDIA_BUCKET,
            Key: storageKey,
            Body: font.bytes,
            ContentType: mimeType,
            CacheControl: 'public, max-age=31536000, immutable',
          }),
        )
      } catch (err) {
        log.warn(
          { err, zipPath: font.zipPath, typeface: font.typeface },
          'pptx: MinIO font upload failed, skipping',
        )
        return null
      }
      // The parser's `typeface` attr (`<p:font typeface="Druk Wide">`) is
      // the family name slide content references. opentype.js's family
      // name might differ (e.g. "Druk Wide Bold" vs "Druk Wide"). Prefer
      // the PPTX-authored typeface so font-family CSS lookups resolve.
      return {
        id: assetId,
        deckId,
        uploaderUserId: ownerUserId,
        mimeType,
        sizeBytes: font.bytes.byteLength,
        storageKey,
        originalFilename: font.zipPath.split('/').pop() ?? null,
        kind: 'font',
        // Sanitise the PPTX-authored typeface at the import boundary — it
        // becomes a font-family CSS value on the client. A legit typeface is
        // plain letters/spaces and survives untouched; a hostile one is
        // stripped (null → client falls back to a default family).
        fontFamily: sanitizeFontFamily(font.typeface) ?? null,
        fontWeight: metadata.weight,
        fontStyle: metadata.style,
        fontPostscriptName: metadata.postscriptName,
        fontAxes: metadata.axes ?? {},
      }
    },
  )
  const mediaAssetRows: MediaRow[] = fontRows.filter((r): r is MediaRow => r !== null)
  const uploadedFontCount = mediaAssetRows.length
  const skippedFontCount = fontRows.length - uploadedFontCount
  endPhase('import', 'fonts')

  // Largest first: an oversize picture's downscale takes seconds, and one
  // that started last would finish long after everything else. The results
  // are put back in the deck's order below.
  const embedded = [...parsed.embeddedImages.values()]
  const oversize = new WeightedSemaphore(OVERSIZE_PIXEL_BUDGET)
  const bySize = embedded.map((_, i) => i).sort((a, b) => embedded[b]!.size - embedded[a]!.size)
  const picturesBySize = await mapConcurrent(
    bySize.map((i) => embedded[i]!),
    IMPORT_MEDIA_CONCURRENCY,
    async (media): Promise<'unsupported' | null | { row: MediaRow; job?: TranscodeJob }> => {
      const { zipPath } = media
      const isImage = SUPPORTED_IMAGE_MIME.has(media.mimeType)
      const isVideo = SUPPORTED_VIDEO_MIME.has(media.mimeType)
      if (!isImage && !isVideo) return 'unsupported'
      const assetId = nanoid(12)
      const storageKey = `decks/${deckId}/uploads/${assetId}/original.${media.ext}`
      // Inflated only now, and released when this task ends: the deck's
      // pictures are never all in memory at once.
      let bytes: Buffer
      try {
        bytes = await media.read()
      } catch (err) {
        log.warn({ err, zipPath }, 'pptx: reading an embedded file failed, skipping asset')
        return null
      }
      // A raster above imgproxy's source limit would never render (422), so
      // it is brought under the limit here, in its own format — see
      // media/storedImageLimits.ts. A failed downscale stores the original.
      let body = bytes
      let dims: { width: number; height: number } | null = null
      // The header's size (read without decoding) says whether this picture
      // will be decoded at full size; it is also the row's size when it is not.
      const header = isImage ? probeImageDims(bytes) : null
      if (isImage) {
        const pixels =
          header !== null && exceedsStoredImageLimits(header.width, header.height)
            ? header.width * header.height
            : 0
        try {
          const downscaled =
            pixels > 0
              ? await oversize.run(pixels, () => downscaleForStorage(bytes, media.mimeType))
              : await downscaleForStorage(bytes, media.mimeType)
          if (downscaled !== null) {
            log.info(
              {
                zipPath,
                fromBytes: bytes.byteLength,
                toBytes: downscaled.bytes.byteLength,
                width: downscaled.width,
                height: downscaled.height,
              },
              'pptx: downscaled oversize image to the stored-image limits',
            )
            body = downscaled.bytes
            dims = { width: downscaled.width, height: downscaled.height }
          }
        } catch (err) {
          log.warn({ err, zipPath }, 'pptx: downscaling an oversize image failed, storing original')
        }
      }
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: MEDIA_BUCKET,
            Key: storageKey,
            Body: body,
            ContentType: media.mimeType,
            CacheControl: 'public, max-age=31536000, immutable',
          }),
        )
      } catch (err) {
        log.warn({ err, zipPath }, 'pptx: MinIO upload failed, skipping asset')
        return null
      }
      if (isImage && dims === null) dims = header
      return {
        row: {
          id: assetId,
          deckId,
          uploaderUserId: ownerUserId,
          mimeType: media.mimeType,
          sizeBytes: body.byteLength,
          storageKey,
          originalFilename: zipPath.split('/').pop() ?? null,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          kind: isVideo ? 'video' : 'image',
          ...(isVideo ? { transcodeStatus: 'pending' as const } : {}),
        },
        ...(isVideo ? { job: { assetId, storageKey, mimeType: media.mimeType } } : {}),
      }
    },
  )

  const pictures = new Array<(typeof picturesBySize)[number]>(embedded.length)
  bySize.forEach((i, k) => (pictures[i] = picturesBySize[k]!))

  const mediaPathToAssetId = new Map<string, string>()
  const videoTranscodeJobs: TranscodeJob[] = []
  let uploadedImageCount = 0
  let skippedUnsupportedImages = 0
  pictures.forEach((p, i) => {
    if (p === 'unsupported') {
      skippedUnsupportedImages++
      return
    }
    if (p === null) return
    mediaPathToAssetId.set(embedded[i]!.zipPath, p.row.id!)
    mediaAssetRows.push(p.row)
    if (p.job !== undefined) videoTranscodeJobs.push(p.job)
    uploadedImageCount++
  })

  patchParsedAssetIds(parsed, mediaPathToAssetId)
  endPhase('import', 'images')

  return {
    mediaAssetRows,
    uploadedImageCount,
    skippedUnsupportedImages,
    uploadedFontCount,
    skippedFontCount,
    videoTranscodeJobs,
  }
}

/**
 * Point every parsed shape and background at the asset its embedded media
 * was stored as. Pure — the round-trip harness (pptx/roundtrip.ts) runs the
 * same step in memory, so what it tests is what the importer does.
 *
 * Video shapes get TWO ids: the video file lands on `assetId`, and the
 * blipFill poster (when present) lands on `posterAssetId` so the writer can
 * emit a sibling ImageObject — slides stay visible while the HLS transcode
 * is still pending.
 */
export function patchParsedAssetIds(
  parsed: ParsedPptx,
  mediaPathToAssetId: ReadonlyMap<string, string>,
): void {
  for (const slide of parsed.slides) {
    if (slide.background.imagePath !== undefined) {
      const aid = mediaPathToAssetId.get(slide.background.imagePath)
      if (aid !== undefined) slide.background.assetId = aid
    }
    for (const sh of slide.shapes) {
      const imageAid = sh.imagePath !== undefined ? mediaPathToAssetId.get(sh.imagePath) : undefined
      const videoAid = sh.videoPath !== undefined ? mediaPathToAssetId.get(sh.videoPath) : undefined
      if (sh.kind === 'video') {
        if (videoAid !== undefined) sh.assetId = videoAid
        if (imageAid !== undefined) sh.posterAssetId = imageAid
      } else {
        if (imageAid !== undefined) sh.assetId = imageAid
        if (videoAid !== undefined) sh.assetId = videoAid
      }
      // Table cells with picture fills.
      for (const row of sh.tableCells ?? []) {
        for (const cell of row) {
          const aid =
            cell.imagePath !== undefined ? mediaPathToAssetId.get(cell.imagePath) : undefined
          if (aid !== undefined) cell.assetId = aid
        }
      }
    }
  }
}

function probeImageDims(bytes: Buffer): { width: number; height: number } | null {
  try {
    const r = probeImageSize(bytes)
    if (r === null) return null
    return { width: r.width, height: r.height }
  } catch {
    return null
  }
}

/**
 * Walk every parsed shape (and every run inside text frames + table
 * cells) and collect the distinct `fontFamily` values the deck refers
 * to. Used by the post-import dialog to drive the missing-fonts
 * upload prompt.
 *
 * Filters:
 *  - empty strings (no-ops)
 *  - OOXML theme placeholders (`+mn-lt`, `+mj-lt`, …) — these are not
 *    real font names but indirection through the theme's font scheme
 */
function collectReferencedFontFamilies(parsed: ParsedPptx): string[] {
  const seen = new Set<string>()
  const accept = (s: string | undefined): void => {
    if (typeof s !== 'string') return
    const t = s.trim()
    if (t === '' || t.startsWith('+')) return
    seen.add(t)
  }
  for (const slide of parsed.slides) {
    for (const sh of slide.shapes) {
      accept(sh.fontFamily)
      if (Array.isArray(sh.textRuns)) {
        for (const r of sh.textRuns) accept(r.fontFamily)
      }
      if (Array.isArray(sh.tableCells)) {
        for (const row of sh.tableCells) {
          for (const cell of row) {
            if (cell === null) continue
            accept(cell.fontFamily)
            if (Array.isArray(cell.textRuns)) {
              for (const r of cell.textRuns) accept(r.fontFamily)
            }
          }
        }
      }
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b))
}

/**
 * Pick a sensible deck title from the original filename. Falls back to
 * a generic name when the filename is missing, empty, or too long.
 */
export function deriveTitle(rawFilename: string | undefined): string {
  if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
    return 'Imported deck'
  }
  const trimmed = rawFilename.replace(/\.pptx$/i, '').trim()
  if (trimmed.length === 0 || trimmed.length > 200) return 'Imported deck'
  return trimmed
}
