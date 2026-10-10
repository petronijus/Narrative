/**
 * routes/pngExport.ts
 *
 * One slide of a deck as a PNG download — the editor's "Export as PNG".
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
import type { FastifyInstance } from 'fastify'
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
