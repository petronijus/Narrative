/**
 * routes/pptxExport.ts
 *
 * Deck → `.pptx` download, streamed: the package's size is known before its
 * first byte (pptx/zipWriter.ts), so the response carries `Content-Length`
 * and the bytes go out as they are produced — the media read from storage
 * a stream at a time, never the whole file in memory. A failure before the
 * first byte is a JSON error; one while streaming (storage failing on the
 * second read) cuts the response short, which the browser reports as a
 * failed download rather than a broken file. A client that goes away stops
 * the export (its reads of storage) with it.
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

import { PassThrough } from 'node:stream'
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
        exported = await createPptxService(routeDeps(app, db, request.log)).exportPackage({
          deckId: request.params.id,
        })
      } catch (err) {
        return sendServiceError(reply, err)
      }
      const body = new PassThrough()
      // A client that went away stops the write (pipeline destroys `body`).
      const gone = new AbortController()
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) gone.abort()
      })
      // The pace is the client's: one source opened ahead, near the end of
      // the current one, so a slow download holds one idle storage read at most.
      exported.package
        .writeTo(body, { signal: gone.signal, readAhead: 1 })
        .catch((err: unknown) => {
          if (!gone.signal.aborted)
            request.log.error({ err, deckId: request.params.id }, 'pptx-export: streaming failed')
        })
      return reply
        .status(200)
        .header('Content-Type', PPTX_CONTENT_TYPE)
        .header('Content-Disposition', attachmentDisposition(exported.filename))
        .header('Content-Length', String(exported.package.size))
        .header('Cache-Control', 'private, no-store')
        .send(body)
    },
  )
}
