/**
 * routes/devRender.ts — development only (BYPASS_AUTH)
 *
 *   POST /dev/render-token  { deckId }  →  { token }
 *
 * Mints a render token (auth/renderTokens.ts) for a deck the dev user can
 * read, so the e2e suite can open the render page exactly as the render
 * worker does — `?share_token=nrr_…`, read-only, without appearing as a
 * collaborator (apps/web/e2e/render-page.spec.ts). In every other setup only
 * the server mints render tokens, in process, for its own render jobs; this
 * route is registered only when BYPASS_AUTH is on, which the boot check
 * (`assertAuthBootSafety`, auth/fastifyAuth.ts) refuses in production.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { mintRenderToken } from '../auth/renderTokens.js'

export async function registerDevRenderRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.post<{ Body: { deckId?: unknown } }>(
    '/dev/render-token',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const deckId = request.body?.deckId
      if (typeof deckId !== 'string' || deckId === '') {
        return reply.status(400).send({ error: 'deckId required' })
      }
      const userId = request.user!.sub
      const access = await resolveDeckAccess(db, { deckId, userId })
      if (!access) return reply.status(403).send({ error: 'Forbidden' })
      return reply.send({ token: mintRenderToken(deckId, userId) })
    },
  )
}
