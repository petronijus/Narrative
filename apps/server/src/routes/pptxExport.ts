/**
 * routes/pptxExport.ts
 *
 * Synchronous deck → `.pptx` download.
 *
 * Endpoint:
 *   GET /decks/:id/export.pptx
 *     Auth: editor+ role on the deck.
 *     Response: `application/vnd.openxmlformats-officedocument.presentationml.presentation`
 *               body = the .pptx bytes (no JSON wrapper).
 *
 * The pipeline is pptx/exportDeck.ts, called through services/pptx.ts — the
 * same code the `deck.exportPptx` agent command runs. It exports the LIVE
 * document (what open editors see now), resolves folder colour tokens, and
 * writes the package with the OOXML writer the importer shares its
 * vocabulary with.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { createPptxService } from '../services/pptx.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { attachmentDisposition, PPTX_CONTENT_TYPE } from '../pptx/exportDeck.js'

// The token-resolution helpers moved to pptx/exportDeck.ts with the pipeline;
// re-exported for their tests and any other importer.
export {
  replaceUnresolvedTokens,
  resolveSlideTokens,
  UNRESOLVED_TOKEN_COLOUR,
} from '../pptx/exportDeck.js'

export async function registerPptxExportRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.get<{ Params: { id: string } }>(
    '/decks/:id/export.pptx',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      let exported
      try {
        exported = await createPptxService(routeDeps(app, db, request.log)).exportBytes({
          deckId: request.params.id,
        })
      } catch (err) {
        return sendServiceError(reply, err)
      }
      return reply
        .status(200)
        .header('Content-Type', PPTX_CONTENT_TYPE)
        .header('Content-Disposition', attachmentDisposition(exported.filename))
        .header('Content-Length', String(exported.buffer.byteLength))
        .send(exported.buffer)
    },
  )
}
