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
 *
 *   POST /decks/:id/insert-slides
 *     JSON `{ sourceDeckId, slideIds, at? }`: copy chosen slides of another
 *     deck into this one (the editor's cross-deck slide paste).
 *
 * Shared implementation: the handlers call services/pptx.ts — the same code the
 * `deck.importPptx / deck.insertFrom` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Database } from '../db/client.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { createPptxService } from '../services/pptx.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'

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
      const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader

      try {
        const result = await createPptxService(routeDeps(app, db, request.log)).importPptx({
          userId: ownerUserId,
          folderId,
          source: { kind: 'bytes', bytes: body, filename },
        })
        return reply.status(201).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // ─── Append-pptx route ───────────────────────────────────────────────────
  // Mirrors /folders/:folderId/import-pptx but takes a deck id instead and
  // inserts the parsed slides into the existing deck. `?at=N` puts the first
  // imported slide at index N (the slides panel's drop position); without it
  // they land at the end (an API caller's default; the editor itself always
  // sends the drop index since the toolbar's Append button went in 0.9.19).
  //
  // The pipeline itself lives in pptx/appendDeck.ts because the tus upload
  // path — what the editor actually uses, since only tus reports progress —
  // has to run exactly the same steps.
  app.post<{ Params: { id: string }; Querystring: { at?: string } }>(
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

      const insertAt = parseInsertAt(request.query.at)
      if (insertAt === 'invalid') {
        return reply.status(400).send({ error: '`at` must be a non-negative integer' })
      }

      try {
        const result = await createPptxService(routeDeps(app, db, request.log)).appendPptx({
          userId: ownerUserId,
          deckId,
          bytes: body,
          insertAt,
        })
        return reply.status(200).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // ─── Insert slides from another deck ─────────────────────────────────────
  // The editor's cross-deck slide paste: body `{ sourceDeckId, slideIds, at? }`.
  // Copying needs editor access to the SOURCE deck too (the export rule),
  // media referenced by the slides is copied into this deck and token
  // references are rebound across folders — `deck.insertFrom`'s deck source,
  // the same service code (services/deckInsert.ts).
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/decks/:id/insert-slides',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const parsed = InsertSlidesBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        })
      }
      try {
        const result = await createPptxService(
          routeDeps(app, db, request.log),
        ).insertSlidesFromDeck({
          userId: request.user!.sub,
          deckId: request.params.id,
          sourceDeckId: parsed.data.sourceDeckId,
          slideIds: parsed.data.slideIds,
          at: parsed.data.at,
        })
        return reply.status(200).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}

const Id = z.string().min(1).max(128)
const InsertSlidesBody = z.strictObject({
  sourceDeckId: Id,
  slideIds: z.array(Id).min(1).max(500),
  at: z.number().int().min(0).optional(),
})

/**
 * Read the `at` query parameter. Absent → undefined (append at the end);
 * a non-negative integer → that index; anything else → 'invalid', which the
 * route turns into a 400 rather than silently appending, because a caller
 * that sent `at=abc` has a bug it deserves to hear about. An index PAST the
 * end is not invalid: the deck can legitimately shrink between the drop and
 * the upload finishing, and the writer clamps.
 */
function parseInsertAt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(raw)) return 'invalid'
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : 'invalid'
}
