/**
 * routes/tokenUsages.ts
 *
 * M16 P4 — Token usage scanning endpoint.
 *
 * Endpoint:
 *   GET /folders/:folderId/tokens/:category/:tokenId/usages
 *
 * Auth: folder owner only (same rule as all other folder-scoped endpoints).
 *
 * Response:
 *   { usages: UsageEntry[] }
 *
 * Implementation:
 *   1. Verify folder ownership.
 *   2. Load the folder Y.Doc from folder_updates → scan textStyle token refs
 *      (only when category === 'colors').
 *   3. List all decks in the folder → load each from deck_updates → scan.
 *   4. List all components in the folder → load each from component_updates → scan.
 *   5. Return all collected UsageEntry items.
 *
 * No caching — this is delete-time only and expected to be called rarely.
 * A folder with thousands of slides may take 1–2 s; that is acceptable.
 *
 * No Hocuspocus connections are opened — we read directly from the DB and
 * apply updates via Y.applyUpdate on fresh Y.Doc instances.
 *
 * Shared implementation: the handlers call services/tokens.ts — the same code the
 * `token.usages` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import type { TokenCategory } from '@narrative/commands'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { createTokensService } from '../services/tokens.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerTokenUsageRoutes(app: FastifyInstance, db: Database): Promise<void> {
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
        const result = await createTokensService(routeDeps(app, db, request.log)).usages({
          userId: request.user!.sub,
          folderId,
          // Validated by the service (400 for an unknown category).
          category: category as TokenCategory,
          tokenId,
        })
        return reply.send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
