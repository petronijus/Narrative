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
 *   - Verify folder ownership.
 *   - Parse pptx via `parsePptx`.
 *   - Upload every embedded image / video to MinIO under the new deck's
 *     namespace, patching the parsed shapes' `assetId` fields.
 *   - Build a Y.Doc state buffer via `buildDeckUpdate`.
 *   - Insert deck + permission + media_assets + deck_updates in one tx.
 *
 * The function is loader-friendly: callers pass their own logger so the
 * tus path can use `fastify.log`'s child logger while the route path uses
 * `request.log`. Returns the same result shape both paths surface to the
 * client (matches `apps/web/src/api/client.ts:ImportPptxResult`).
 */

import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { decks, deckPermissions, deckUpdates, folders, mediaAssets } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { enqueueVideoTranscode } from '../media/enqueue.js'
import { parseFontMetadata } from '../media/fontMetadata.js'
import { downscaleForStorage } from '../media/storedImageLimits.js'
import { parsePptx, type ParsedEmbeddedImage, type ParsedPptx } from './parser.js'
import { buildDeckUpdate } from './writer.js'
import { sanitizeFontFamily } from '@narrative/slide-model'

const require = createRequire(import.meta.url)
interface ProbeResult {
  width: number
  height: number
  type: string
}
const probeImageSize: (
  stream: Readable,
) => Promise<ProbeResult | null> = require('probe-image-size')

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
}): Promise<{ ok: true; result: ImportDeckResult } | { ok: false; error: ImportDeckError }> {
  const { bytes, folderId, ownerUserId, filenameForTitle, db, log } = args

  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'emptyBody' } }
  }

  // Verify folder ownership before doing expensive parse work.
  const [folder] = await db
    .select({ id: folders.id, ownerUserId: folders.ownerUserId })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)
  if (!folder) return { ok: false, error: { kind: 'folderNotFound' } }
  if (folder.ownerUserId !== ownerUserId) {
    return { ok: false, error: { kind: 'forbidden' } }
  }

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

  const {
    mediaAssetRows,
    uploadedImageCount,
    skippedUnsupportedImages,
    uploadedFontCount,
    skippedFontCount,
    videoTranscodeJobs,
  } = await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, log)

  const { state, slideCount, objectsCreated, skipped } = buildDeckUpdate(parsed)

  const insertedDeck = await db.transaction(async (tx) => {
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
    if (!deck) return null

    await tx.insert(deckPermissions).values({
      deckId,
      userId: ownerUserId,
      role: 'owner',
      grantedAt: now,
      grantedBy: ownerUserId,
    })

    if (mediaAssetRows.length > 0) {
      await tx.insert(mediaAssets).values(mediaAssetRows)
    }

    await tx.insert(deckUpdates).values({
      deckId,
      update: state,
      createdAt: now,
    })

    return deck
  })

  if (!insertedDeck) {
    return { ok: false, error: { kind: 'deckInsertFailed' } }
  }

  // Enqueue HLS transcode for every imported video. We do this AFTER the
  // tx commits so the worker never picks up a job before the media_assets
  // row exists. Same pattern as the tus upload path — failures are logged
  // and don't fail the import; the operator can re-enqueue manually.
  for (const job of videoTranscodeJobs) {
    try {
      await enqueueVideoTranscode({
        assetId: job.assetId,
        deckId,
        storageKey: job.storageKey,
        uploaderUserId: ownerUserId,
        mimeType: job.mimeType,
      })
    } catch (err) {
      log.warn({ err, assetId: job.assetId }, 'pptx: enqueueVideoTranscode failed')
    }
  }

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
    },
  }
}

/**
 * Walk the parsed deck's embedded media (images + videos), upload each
 * to MinIO under the new deck's namespace, and patch the parsed shapes'
 * `assetId` fields so the writer's Y.Doc output points to the right
 * media_assets rows. Unsupported MIME types (e.g. WMF, EMF) are skipped
 * and counted so the caller can surface the loss.
 *
 * Public for reuse by the append-pptx route which mirrors this step.
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
  const mediaPathToAssetId = new Map<string, string>()
  const mediaAssetRows: Array<typeof mediaAssets.$inferInsert> = []
  const videoTranscodeJobs: Array<{
    assetId: string
    storageKey: string
    mimeType: string
  }> = []
  let uploadedImageCount = 0
  let skippedUnsupportedImages = 0

  // ─── Embedded fonts ────────────────────────────────────────────────────
  // Walk `<p:embeddedFontLst>` faces first — they're independent of the
  // image/video pipeline and reach the deck via `/api/decks/:id/fonts`
  // (which the editor's FolderFontLoader auto-subscribes to). One
  // media_assets row per (typeface × variant) face. parseFontMetadata
  // is the same opentype.js entry point the tus font-upload route uses;
  // mismatched / corrupt bytes log + skip instead of crashing the
  // entire import.
  let uploadedFontCount = 0
  let skippedFontCount = 0
  for (const font of parsed.embeddedFonts) {
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
      skippedFontCount++
      continue
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
      skippedFontCount++
      continue
    }
    // The parser's `typeface` attr (`<p:font typeface="Druk Wide">`) is
    // the family name slide content references. opentype.js's family
    // name might differ (e.g. "Druk Wide Bold" vs "Druk Wide"). Prefer
    // the PPTX-authored typeface so font-family CSS lookups resolve.
    mediaAssetRows.push({
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
    })
    uploadedFontCount++
  }

  for (const [zipPath, media] of parsed.embeddedImages) {
    const isImage = SUPPORTED_IMAGE_MIME.has(media.mimeType)
    const isVideo = SUPPORTED_VIDEO_MIME.has(media.mimeType)
    if (!isImage && !isVideo) {
      skippedUnsupportedImages++
      continue
    }
    const assetId = nanoid(12)
    const storageKey = `decks/${deckId}/uploads/${assetId}/original.${media.ext}`
    // A raster above imgproxy's source limit would never render (422), so
    // it is brought under the limit here, in its own format — see
    // media/storedImageLimits.ts. A failed downscale stores the original.
    let body = media.bytes
    let dims: { width: number; height: number } | null = null
    if (isImage) {
      try {
        const downscaled = await downscaleForStorage(media.bytes, media.mimeType)
        if (downscaled !== null) {
          log.info(
            {
              zipPath,
              fromBytes: media.bytes.byteLength,
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
      continue
    }
    if (isImage && dims === null) dims = await probeImageDims(media)
    mediaPathToAssetId.set(zipPath, assetId)
    mediaAssetRows.push({
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
    })
    if (isVideo) {
      videoTranscodeJobs.push({ assetId, storageKey, mimeType: media.mimeType })
    }
    uploadedImageCount++
  }

  // Patch parsed shapes + backgrounds with their resolved assetIds.
  // Video shapes get TWO ids: the video file lands on `assetId`, and the
  // blipFill poster (when present) lands on `posterAssetId` so the writer
  // can emit a sibling ImageObject — slides stay visible while the HLS
  // transcode is still pending.
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
    }
  }

  return {
    mediaAssetRows,
    uploadedImageCount,
    skippedUnsupportedImages,
    uploadedFontCount,
    skippedFontCount,
    videoTranscodeJobs,
  }
}

async function probeImageDims(
  img: ParsedEmbeddedImage,
): Promise<{ width: number; height: number } | null> {
  try {
    const r = await probeImageSize(Readable.from(img.bytes))
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
