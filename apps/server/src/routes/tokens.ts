/**
 * routes/tokens.ts — a folder's design tokens, for the Folder Settings page
 * and the Inspector's text-style actions. Folder owner only.
 *
 *   GET    /folders/:folderId/tokens/:category/:tokenId/usages   → { usages }
 *     Every reference to the token in the folder's decks, component masters
 *     and (for a colour) text styles, read from the stored documents; no
 *     sync-server connection is opened. Delete-time, called rarely.
 *   POST   /folders/:folderId/tokens/:category                   → { tokenId }
 *     Body: the token's fields (`{ name, value }` for a colour, …).
 *   PATCH  /folders/:folderId/tokens/:category/:tokenId          → { propagated }
 *     Body: the fields to change (`null` removes an optional one). Linked
 *     text in every deck and component master of the folder follows.
 *   DELETE /folders/:folderId/tokens/:category/:tokenId          → { deleted }
 *
 * Every handler calls services/tokens.ts — the same code the `token.*`
 * commands run (ADR 0010), so the page and an agent cannot drift apart; the
 * service validates the fields (400 with `issues`). The folder document is
 * written through the sync server, so editors see the change at once. The
 * writes need the web app's own origin for session callers
 * (`requireSameOrigin`) and are rate-limited per caller.
 */

import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import {
  tokenDelete,
  type EditableTokenCategory,
  type TokenCategory,
  type TokenService,
} from '@narrative/commands'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { tokenWriteRouteRateLimit } from '../http/rateLimit.js'
import { requireSameOrigin } from '../http/sameOrigin.js'
import { createTokensService } from '../services/tokens.js'
import { routeDeps } from '../services/http.js'
import { badRequest, sendServiceError } from '../services/errors.js'

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerTokenRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const service = (request: { log: FastifyBaseLogger }): TokenService =>
    createTokensService(routeDeps(app, db, request.log))

  // -------------------------------------------------------------------------
  // GET /folders/:folderId/tokens/:category/:tokenId/usages
  // -------------------------------------------------------------------------
  app.get<{
    Params: { folderId: string; category: string; tokenId: string }
  }>(
    '/folders/:folderId/tokens/:category/:tokenId/usages',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { folderId, category, tokenId } = request.params
      try {
        const result = await service(request).usages({
          userId: request.user!.sub,
          folderId,
          // Validated by the service (400 for an unknown category).
          category: category as TokenCategory,
          tokenId: requireTokenId(tokenId),
        })
        return reply.send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // Writes re-style every deck of the folder: session callers must come
  // from the web app itself (as for POST /commands), and each caller is
  // rate-limited on top of the per-folder queue in services/tokens.ts.
  const write = {
    config: tokenWriteRouteRateLimit,
    preHandler: [authPreHandler, requireSameOrigin],
  }

  // -------------------------------------------------------------------------
  // POST /folders/:folderId/tokens/:category
  // -------------------------------------------------------------------------
  app.post<{ Params: { folderId: string; category: string }; Body: unknown }>(
    '/folders/:folderId/tokens/:category',
    write,
    async (request, reply) => {
      try {
        const { category: _ignored, ...fields } = bodyObject(request.body)
        const result = await service(request).create({
          userId: request.user!.sub,
          folderId: request.params.folderId,
          // Validated by the service (400 for anything but colors / textStyles).
          category: request.params.category as EditableTokenCategory,
          fields,
        })
        return reply.status(201).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // PATCH /folders/:folderId/tokens/:category/:tokenId
  // -------------------------------------------------------------------------
  app.patch<{ Params: { folderId: string; category: string; tokenId: string }; Body: unknown }>(
    '/folders/:folderId/tokens/:category/:tokenId',
    write,
    async (request, reply) => {
      try {
        const tokenId = requireTokenId(request.params.tokenId)
        const result = await service(request).update({
          userId: request.user!.sub,
          folderId: request.params.folderId,
          category: request.params.category as EditableTokenCategory,
          tokenId,
          patch: bodyObject(request.body),
        })
        return reply.send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /folders/:folderId/tokens/:category/:tokenId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { folderId: string; category: string; tokenId: string } }>(
    '/folders/:folderId/tokens/:category/:tokenId',
    write,
    async (request, reply) => {
      try {
        const result = await service(request).delete({
          userId: request.user!.sub,
          folderId: request.params.folderId,
          // Validated by the service (400 for an unknown category).
          category: request.params.category as TokenCategory,
          tokenId: requireTokenId(request.params.tokenId),
        })
        return reply.send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}

/** The request body as an object to spread (anything else is no fields, which the schema refuses). */
function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}

/** A token id as the commands take it (`tokenDelete`'s schema); 400 otherwise. */
function requireTokenId(tokenId: string): string {
  const parsed = tokenDelete.input.shape.tokenId.safeParse(tokenId)
  if (!parsed.success) throw badRequest('Invalid token id')
  return parsed.data
}
