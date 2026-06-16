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

import type { FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckUpdates, mediaAssets } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { parsePptx, type ParsedPptx } from '../pptx/parser.js'
import { buildDeckAppendUpdate } from '../pptx/writer.js'
import {
  importDeckFromPptxBytes,
  uploadEmbeddedImagesAndPatchAssetIds,
} from '../pptx/importDeck.js'

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * Hard upper bound on accepted upload size, applied at both the Fastify
 * content-type parser and the per-route post-parse check.
 *
 * **Practical caveats**: the import pipeline buffers the WHOLE file in
 * memory (parser → JSZip → XML tree → Y.Doc). A 2 GB `.pptx` decompresses
 * to ~5-10 GB and the parser tree adds hundreds of MB on top — peak
 * working set can land around 10-15 GB. The dev script bumps Node's
 * `--max-old-space-size` to 8 GB; for production deploys you'll want at
 * least a 16 GB container or a switch to the streaming/chunked tus
 * upload path (already used by general media uploads but not yet wired
 * for pptx). Until then, this cap is "supported up to the limit your
 * machine can hold."
 *
 * The on-the-wire size cap stays at 2 GB by product requirement (large
 * decks must import). DoS protection comes from the parser's decompression-
 * bomb guard (`assertNotZipBomb`), which rejects *pathological* archives
 * (absurd compression ratios / entry counts) without limiting legitimate
 * large files — NOT from a low byte cap.
 */
export const MAX_PPTX_BYTES = Number(process.env['MAX_PPTX_BYTES'] ?? 2 * 1024 * 1024 * 1024)

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

      const filenameHeader = request.headers['x-narrative-filename']
      const filenameForTitle = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader

      const importResult = await importDeckFromPptxBytes({
        bytes: body,
        folderId,
        ownerUserId,
        ...(typeof filenameForTitle === 'string' ? { filenameForTitle } : {}),
        db,
        log: request.log,
      })

      if (!importResult.ok) {
        const { error } = importResult
        if (error.kind === 'folderNotFound') {
          return reply.status(404).send({ error: 'Folder not found' })
        }
        if (error.kind === 'forbidden') {
          return reply.status(403).send({ error: 'Forbidden' })
        }
        if (error.kind === 'parseFailed') {
          return reply.status(400).send({ error: `Could not parse .pptx — ${error.message}` })
        }
        if (error.kind === 'noSlides') {
          return reply.status(400).send({ error: '.pptx contains no slides' })
        }
        if (error.kind === 'emptyBody') {
          return reply.status(400).send({ error: 'Empty body' })
        }
        return reply.status(500).send({ error: 'Failed to create deck' })
      }

      return reply.status(201).send(importResult.result)
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
        await uploadEmbeddedImagesAndPatchAssetIds(parsed, deckId, ownerUserId, request.log)

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
