/**
 * routes/insertObjects.ts — the body and the handling shared by the editor's
 * cross-document paste routes, POST /decks/:id/insert-objects and
 * POST /components/:id/insert-objects (`object.insertFromDeck`): objects
 * read from another deck or component master onto a slide of this one,
 * their media copied (services/deckInsert.ts `insertObjectsFrom`).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { MAX_INSERT_OBJECTS } from '@narrative/commands'
import type { Database } from '../db/client.js'
import type { MediaOwner } from '../media/mediaOwner.js'
import { insertObjectsFrom } from '../services/deckInsert.js'
import { routeDeps } from '../services/http.js'
import { sendCommandOrServiceError } from '../services/errors.js'

const Id = z.string().min(1).max(64)
const Point = z.strictObject({ x: z.number().finite(), y: z.number().finite() })

/**
 * The paste body: exactly one source document, the slide, the objects
 * (validated by `planInsert`) and where they go.
 */
const InsertObjectsBody = z
  .strictObject({
    sourceDeckId: Id.optional(),
    sourceComponentId: Id.optional(),
    slideId: Id,
    objects: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_INSERT_OBJECTS),
    offset: Point.optional(),
    at: Point.optional(),
  })
  .refine((b) => (b.sourceDeckId === undefined) !== (b.sourceComponentId === undefined), {
    message: 'give sourceDeckId or sourceComponentId, exactly one',
    path: ['sourceDeckId'],
  })

/** Validate the body and paste onto `target`; answers the route. */
export async function sendInsertObjects(
  app: FastifyInstance,
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  target: MediaOwner,
) {
  const parsed = InsertObjectsBody.safeParse(request.body)
  if (!parsed.success) {
    return reply.status(400).send({
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; '),
    })
  }
  const { sourceDeckId, sourceComponentId, ...placement } = parsed.data
  const source: MediaOwner =
    sourceComponentId !== undefined ? { componentId: sourceComponentId } : { deckId: sourceDeckId! }
  try {
    const result = await insertObjectsFrom(routeDeps(app, db, request.log), {
      userId: request.user!.sub,
      source,
      target,
      ...placement,
    })
    return reply.status(200).send(result)
  } catch (err) {
    return sendCommandOrServiceError(reply, err)
  }
}
