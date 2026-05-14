/**
 * routes/pptxImport.ts
 *
 * Synchronous .pptx import — takes a raw .pptx body, parses it on the request
 * thread, writes a Y.Doc update into `deck_updates`, returns the new deckId.
 *
 * Endpoint:
 *   POST /folders/:folderId/import-pptx
 *     Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation
 *     Body: raw .pptx bytes (max 50 MB, enforced both at the content-type
 *           parser level and by re-checking buffer.byteLength here).
 *
 * Why synchronous instead of BullMQ? The MVP per the M28 plan calls for a
 * worker, but for the first interactive smoke-test we keep latency obvious
 * (the client awaits the response and navigates straight to the new deck).
 * Move to a queue once import latency exceeds a couple of seconds in the
 * wild — the route's only side-effect is two DB inserts so swapping it for
 * a job-enqueue is a small refactor.
 *
 * Auth: same as POST /decks — caller must own the destination folder.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import * as Y from 'yjs'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { decks, deckPermissions, deckUpdates, folders, mediaAssets } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { parsePptx, type ParsedEmbeddedImage, type ParsedPptx } from '../pptx/parser.js'
import { buildDeckUpdate, buildDeckAppendUpdate } from '../pptx/writer.js'

// probe-image-size is CJS — same dance as media/tus.ts. Pulled in via
// createRequire so the ESM build still works.
const require = createRequire(import.meta.url)
interface ProbeResult {
  width: number
  height: number
  type: string
}
const probeImageSize: (
  stream: Readable,
) => Promise<ProbeResult | null> = require('probe-image-size')

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** Hard upper bound on accepted upload size, applied at both layers. */
export const MAX_PPTX_BYTES = 50 * 1024 * 1024

export async function registerPptxImportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // ─── Content-type parser ─────────────────────────────────────────────────
  // Fastify defaults reject anything that isn't JSON / form. Register the
  // pptx mime as a raw-buffer parser with our explicit size cap.
  app.addContentTypeParser(
    PPTX_MIME,
    { parseAs: 'buffer', bodyLimit: MAX_PPTX_BYTES },
    (_req, body, done) => {
      // body is already a Buffer here per parseAs: 'buffer'.
      done(null, body)
    },
  )

  // ─── Route handler ───────────────────────────────────────────────────────
  app.post<{ Params: { folderId: string } }>(
    '/folders/:folderId/import-pptx',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const ownerUserId = request.user!.sub
      const { folderId } = request.params

      const body = request.body
      if (!Buffer.isBuffer(body)) {
        return reply.status(400).send({
          error: 'Invalid request body — expected raw .pptx bytes',
        })
      }
      if (body.byteLength === 0) {
        return reply.status(400).send({ error: 'Empty body' })
      }
      if (body.byteLength > MAX_PPTX_BYTES) {
        return reply.status(413).send({
          error: `File too large (${body.byteLength} > ${MAX_PPTX_BYTES} bytes)`,
        })
      }

      // ─── Verify folder ownership ───────────────────────────────────────────
      const [folder] = await db
        .select({ id: folders.id, ownerUserId: folders.ownerUserId })
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1)
      if (!folder) {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (folder.ownerUserId !== ownerUserId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // ─── Parse ─────────────────────────────────────────────────────────────
      let parsed
      try {
        parsed = await parsePptx(body)
      } catch (err) {
        request.log.warn({ err }, 'pptx-import: parse failed')
        return reply.status(400).send({
          error: `Could not parse .pptx — ${err instanceof Error ? err.message : 'unknown error'}`,
        })
      }
      if (parsed.slides.length === 0) {
        return reply.status(400).send({ error: '.pptx contains no slides' })
      }

      const deckId = nanoid(12)
      const title = deriveTitle(request.headers['x-narrative-filename'])
      const now = new Date()

      // ─── Upload embedded images + patch assetIds onto parsed shapes ──────
      // Extracted helper so the append route reuses the exact same upload
      // pipeline.
      const { mediaAssetRows, uploadedImageCount, skippedUnsupportedImages } =
        await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, request)

      // ─── Build Y.Doc state buffer (now with image assetIds wired in) ──────
      const { state, slideCount, objectsCreated, skipped } = buildDeckUpdate(parsed)

      // ─── Persist: deck + permissions + media_assets + deck_updates, one tx ─
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

        // Single row carrying the full initial state — Hocuspocus will replay
        // this on the next onLoadDocument and clients will see all slides.
        await tx.insert(deckUpdates).values({
          deckId,
          update: state,
          createdAt: now,
        })

        return deck
      })

      if (!insertedDeck) {
        return reply.status(500).send({ error: 'Failed to create deck' })
      }

      request.log.info(
        {
          deckId,
          slideCount,
          objectsCreated,
          skippedImages: skipped.images + skippedUnsupportedImages,
          skippedUnknown: skipped.unknownShapes,
          uploadedImages: uploadedImageCount,
          ignored: parsed.ignoredElements,
        },
        'pptx-import: deck created',
      )

      return reply.status(201).send({
        deckId,
        slideCount,
        objectsCreated,
        skipped: {
          images: skipped.images + skippedUnsupportedImages,
          unknownShapes: skipped.unknownShapes,
        },
        ignoredElements: parsed.ignoredElements,
        slideWidth: parsed.slideWidth,
        slideHeight: parsed.slideHeight,
      })
    },
  )

  // ─── Append-pptx route ───────────────────────────────────────────────────
  // Mirrors /folders/:folderId/import-pptx but takes a deck id instead and
  // appends the parsed slides at the end of the existing deck via a
  // differential Y.Doc update. Uses the same MinIO upload pass + asset
  // id wiring as the import route — the only thing that changes is the
  // writer (buildDeckAppendUpdate vs buildDeckUpdate) and the persistence
  // step (no new deck / permission rows, just a new deck_updates row).
  app.post<{ Params: { id: string } }>(
    '/decks/:id/append-pptx',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const ownerUserId = request.user!.sub
      const { id: deckId } = request.params

      const body = request.body
      if (!Buffer.isBuffer(body)) {
        return reply.status(400).send({
          error: 'Invalid request body — expected raw .pptx bytes',
        })
      }
      if (body.byteLength === 0) {
        return reply.status(400).send({ error: 'Empty body' })
      }
      if (body.byteLength > MAX_PPTX_BYTES) {
        return reply.status(413).send({
          error: `File too large (${body.byteLength} > ${MAX_PPTX_BYTES} bytes)`,
        })
      }

      // ─── Parse ─────────────────────────────────────────────────────────
      let parsed: ParsedPptx
      try {
        parsed = await parsePptx(body)
      } catch (err) {
        request.log.warn({ err }, 'pptx-append: parse failed')
        return reply.status(400).send({
          error: `Could not parse .pptx — ${err instanceof Error ? err.message : 'unknown error'}`,
        })
      }
      if (parsed.slides.length === 0) {
        return reply.status(400).send({ error: '.pptx contains no slides' })
      }

      // ─── Upload images + patch assetIds ────────────────────────────────
      // Images for appended slides land under the SAME deckId namespace as
      // the existing deck's media — that's important because the deck's
      // permission grants on `mediaAssets.deckId` apply uniformly.
      const { mediaAssetRows, uploadedImageCount, skippedUnsupportedImages } =
        await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, request)

      // ─── Replay deck_updates → existing Y.Doc → append → diff ──────────
      const updates = await db
        .select({ update: deckUpdates.update })
        .from(deckUpdates)
        .where(eq(deckUpdates.deckId, deckId))
        .orderBy(deckUpdates.id)
      const doc = new Y.Doc()
      for (const row of updates) {
        try {
          Y.applyUpdate(doc, row.update)
        } catch (err) {
          request.log.warn({ err, deckId }, 'pptx-append: skipping corrupt deck_updates row')
        }
      }

      const { state, slideCount, objectsCreated, skipped } = buildDeckAppendUpdate(parsed, doc)
      const now = new Date()

      // ─── Persist: deck_updates diff + new media_assets, one tx ─────────
      // No new deck row — the deck already exists. We don't touch
      // deckPermissions either (the appender already has editor+ access).
      await db.transaction(async (tx) => {
        if (mediaAssetRows.length > 0) {
          await tx.insert(mediaAssets).values(mediaAssetRows)
        }
        await tx.insert(deckUpdates).values({
          deckId,
          update: state,
          createdAt: now,
        })
      })

      request.log.info(
        {
          deckId,
          appendedSlides: slideCount,
          objectsCreated,
          skippedImages: skipped.images + skippedUnsupportedImages,
          skippedUnknown: skipped.unknownShapes,
          uploadedImages: uploadedImageCount,
          ignored: parsed.ignoredElements,
        },
        'pptx-append: slides appended',
      )

      return reply.status(200).send({
        deckId,
        appendedSlides: slideCount,
        objectsCreated,
        skipped: {
          images: skipped.images + skippedUnsupportedImages,
          unknownShapes: skipped.unknownShapes,
        },
        ignoredElements: parsed.ignoredElements,
        slideWidth: parsed.slideWidth,
        slideHeight: parsed.slideHeight,
      })
    },
  )
}

/**
 * Upload every PNG / JPEG / GIF / WebP image referenced by the parsed
 * slides into MinIO under `decks/<deckId>/uploads/<assetId>/original.<ext>`,
 * patch each `ParsedShape.imagePath` / `ParsedBackground.imagePath` ref
 * with the resolved `assetId`, and return the planned `media_assets` rows
 * for the caller to insert inside its own transaction.
 *
 * Mutates `parsed` in place — every shape that previously held only an
 * `imagePath` now also carries an `assetId` the writer can lay onto an
 * `ImageObject`. Vector formats (EMF/WMF/SVG) and MinIO upload failures
 * are tallied separately so the caller can include them in the response
 * skipped counts. Failed uploads leave the shape with no `assetId`, which
 * the writer translates to "drop this image, count as skipped".
 *
 * Pulled out of the import-route's inline pass so the append route can
 * share the exact same image pipeline — keeps both routes' MinIO + asset
 * id wiring identical and orphan-tolerance behaviour aligned (a failed
 * MinIO put leaks the bytes nowhere because we never reference them).
 */
async function uploadEmbeddedImagesAndPatchAssetIds(
  parsed: ParsedPptx,
  deckId: string,
  ownerUserId: string,
  request: FastifyRequest,
): Promise<{
  mediaAssetRows: Array<typeof mediaAssets.$inferInsert>
  uploadedImageCount: number
  skippedUnsupportedImages: number
}> {
  const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const s3 = buildS3Client()
  const imagePathToAssetId = new Map<string, string>()
  const mediaAssetRows: Array<typeof mediaAssets.$inferInsert> = []
  let uploadedImageCount = 0
  let skippedUnsupportedImages = 0

  for (const [zipPath, img] of parsed.embeddedImages) {
    if (!SUPPORTED_IMAGE_MIME.has(img.mimeType)) {
      skippedUnsupportedImages++
      continue
    }
    const assetId = nanoid(12)
    const storageKey = `decks/${deckId}/uploads/${assetId}/original.${img.ext}`
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: MEDIA_BUCKET,
          Key: storageKey,
          Body: img.bytes,
          ContentType: img.mimeType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      )
    } catch (err) {
      request.log.warn({ err, zipPath }, 'pptx: MinIO upload failed, skipping image')
      continue
    }
    const dims = await probeImageDims(img)
    imagePathToAssetId.set(zipPath, assetId)
    mediaAssetRows.push({
      id: assetId,
      deckId,
      uploaderUserId: ownerUserId,
      mimeType: img.mimeType,
      sizeBytes: img.bytes.byteLength,
      storageKey,
      originalFilename: zipPath.split('/').pop() ?? null,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      kind: 'image',
    })
    uploadedImageCount++
  }

  // Patch parsed shapes + backgrounds with their resolved assetIds.
  for (const slide of parsed.slides) {
    if (slide.background.imagePath !== undefined) {
      const aid = imagePathToAssetId.get(slide.background.imagePath)
      if (aid !== undefined) slide.background.assetId = aid
    }
    for (const sh of slide.shapes) {
      if (sh.imagePath !== undefined) {
        const aid = imagePathToAssetId.get(sh.imagePath)
        if (aid !== undefined) sh.assetId = aid
      }
    }
  }

  return { mediaAssetRows, uploadedImageCount, skippedUnsupportedImages }
}

/**
 * Probe image dimensions from a Buffer via probe-image-size. Returns null on
 * any failure — we then leave width/height NULL in media_assets, matching
 * the behaviour of the tus upload path's degraded mode.
 */
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
 * Pick a sensible deck title from the optional filename header. Falls back to
 * a generic name when the client didn't send one or the value is unusable.
 */
function deriveTitle(rawHeader: string | string[] | undefined): string {
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  if (typeof raw !== 'string' || raw.length === 0) return 'Imported deck'
  // Strip .pptx extension + trim. Keep the rest as-is.
  const trimmed = raw.replace(/\.pptx$/i, '').trim()
  if (trimmed.length === 0 || trimmed.length > 200) return 'Imported deck'
  return trimmed
}
