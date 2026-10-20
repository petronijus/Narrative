/**
 * routes/pngExport.ts
 *
 * One slide of a deck as a PNG download — the editor's "Export as PNG" —
 * and the whole deck as a PDF (A5.6, at the end of the file: a job polled
 * for its progress and link).
 *
 *   GET /decks/:id/export.png?slide=<slide id | 0-based index>
 *     Auth: a reader of the deck (the service checks it).
 *     Response: `image/png`, the slide at 1920×1080,
 *     streamed from storage as an attachment named after the deck and the
 *     slide's position.
 *
 * The render is the render worker's (services/render.ts — the same code the
 * `deck.exportPng` agent command runs): the real renderer on the LIVE
 * document, fonts and pictures included. A render is expensive and queued,
 * so the route has its own rate limit, and a request the web app did not make
 * (another site or a sibling subdomain embedding it for a signed-in person)
 * is refused (`isFromWebApp`).
 */

import type { Readable } from 'node:stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { RenderSlideRef } from '@narrative/commands'
import type { Database } from '../db/client.js'
import { decks } from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { isFromWebApp } from '../http/sameOrigin.js'
import { createRenderService, type StoredRender } from '../services/render.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { attachmentDisposition, safeFilename } from '../pptx/exportDeck.js'

/** Slide renders one person may ask for through this route per minute. */
export const PNG_EXPORT_RATE_LIMIT = { max: 20, timeWindowMs: 60_000 } as const

/** `?slide=`: all digits is a 0-based index, anything else a slide id. */
export function slideRefFromQuery(value: string): RenderSlideRef {
  return /^\d+$/.test(value) ? { index: Number(value) } : { id: value }
}

export async function registerPngExportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { slide?: string } }>(
    '/decks/:id/export.png',
    {
      preHandler: authPreHandler,
      config: {
        rateLimit: {
          max: PNG_EXPORT_RATE_LIMIT.max,
          timeWindow: PNG_EXPORT_RATE_LIMIT.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      // Only the web app queues renders with a person's cookie.
      if (!isFromWebApp(request)) {
        return reply.status(403).send({
          error: 'forbidden_origin',
          message: 'This request must come from the Narrative web app.',
        })
      }
      const deckId = request.params.id
      const { slide } = request.query
      if (slide === undefined || slide === '') {
        return reply
          .status(400)
          .send({ error: 'slide is required (a slide id or a 0-based index)' })
      }
      let stored: StoredRender | undefined
      try {
        const rendered = await createRenderService(routeDeps(app, db, request.log)).renderStored({
          userId: request.user!.sub,
          deckId,
          slides: [slideRefFromQuery(slide)],
        })
        stored = rendered.slides[0]
      } catch (err) {
        return sendServiceError(reply, err)
      }
      if (stored === undefined)
        return reply.status(500).send({ error: 'The render returned no image' })
      const object = await buildS3Client().send(
        new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: stored.key }),
      )
      const [deck] = await db
        .select({ title: decks.title })
        .from(decks)
        .where(eq(decks.id, deckId))
        .limit(1)
      const filename = `${safeFilename(deck?.title ?? 'slide')} - slide ${stored.index + 1}.png`
      return reply
        .status(200)
        .header('Content-Type', 'image/png')
        .header('Content-Disposition', attachmentDisposition(filename))
        .header('Content-Length', String(stored.sizeBytes))
        .header('Cache-Control', 'private, no-store')
        .send(object.Body as Readable)
    },
  )
}

/** Deck PDFs one person may start through this route per minute: each is up to 40 slide renders. */
export const PDF_EXPORT_RATE_LIMIT = { max: 4, timeWindowMs: 60_000 } as const
/** Longest a status request may wait for its job to end (`?waitMs=`): under any proxy timeout. */
export const PDF_STATUS_MAX_WAIT_MS = 25_000
/**
 * Status reads one person may make per minute: the editor polls every few
 * seconds (`?waitMs=3000`), well under it; a loop re-reading a finished job
 * is held back (each waiting read holds a listener, each done one a presign).
 */
export const PDF_STATUS_RATE_LIMIT = { max: 60, timeWindowMs: 60_000 } as const

/**
 * The deck as one PDF (A5.6), made as a job so no request waits for it
 * (docs/plans/performance.md, R1; render/pdfExportQueue.ts):
 *
 *   POST /decks/:id/export.pdf   body: { includeSkipped?: boolean }
 *     Auth: a reader of the deck (the service checks it), from the web app.
 *     202 { jobId, status: 'queued', done: 0, total }: the request checked
 *     (access, slides, the caller's share of the queue) and queued.
 *
 *   GET /decks/:id/export.pdf/:jobId[?waitMs=n]
 *     The caller's own job on this deck (404 for any other): `queued` /
 *     `running` with pages done of total, `done` with a link to the file
 *     (15 minutes, an attachment named after the deck), or `failed` with
 *     the reason a request would have been answered. `waitMs` (≤ 25 s)
 *     waits for the job to end first. Its own rate limit
 *     (PDF_STATUS_RATE_LIMIT); the service bounds the waiting reads too.
 */
export async function registerPdfExportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const fromWebApp = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (isFromWebApp(request)) return true
    void reply.status(403).send({
      error: 'forbidden_origin',
      message: 'This request must come from the Narrative web app.',
    })
    return false
  }

  app.post<{ Params: { id: string }; Body: { includeSkipped?: unknown } | undefined }>(
    '/decks/:id/export.pdf',
    {
      preHandler: authPreHandler,
      config: {
        rateLimit: {
          max: PDF_EXPORT_RATE_LIMIT.max,
          timeWindow: PDF_EXPORT_RATE_LIMIT.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      if (!fromWebApp(request, reply)) return reply
      const includeSkipped = request.body?.includeSkipped
      if (includeSkipped !== undefined && typeof includeSkipped !== 'boolean')
        return reply.status(400).send({ error: 'includeSkipped must be a boolean' })
      try {
        const started = await createRenderService(routeDeps(app, db, request.log)).startPdfExport({
          userId: request.user!.sub,
          deckId: request.params.id,
          slides: 'all',
          includeSkipped: includeSkipped === true,
          delivery: 'url',
        })
        return reply.status(202).header('Cache-Control', 'private, no-store').send(started)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  app.get<{ Params: { id: string; jobId: string }; Querystring: { waitMs?: string } }>(
    '/decks/:id/export.pdf/:jobId',
    {
      preHandler: authPreHandler,
      config: {
        rateLimit: {
          max: PDF_STATUS_RATE_LIMIT.max,
          timeWindow: PDF_STATUS_RATE_LIMIT.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      if (!fromWebApp(request, reply)) return reply
      const raw = request.query.waitMs
      const waitMs = raw === undefined ? 0 : Number(raw)
      if (!Number.isFinite(waitMs) || waitMs < 0)
        return reply.status(400).send({ error: 'waitMs must be a number of milliseconds' })
      try {
        const status = await createRenderService(routeDeps(app, db, request.log)).pdfExportStatus({
          userId: request.user!.sub,
          deckId: request.params.id,
          jobId: request.params.jobId,
          waitMs: Math.min(waitMs, PDF_STATUS_MAX_WAIT_MS),
        })
        return reply.status(200).header('Cache-Control', 'private, no-store').send(status)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
