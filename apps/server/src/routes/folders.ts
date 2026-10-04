/**
 * routes/folders.ts
 *
 * REST API for folder management (M16 P1).
 *
 * Endpoints:
 *   GET    /folders                     → list folders for the authenticated user (with deck counts)
 *   POST   /folders                     → create a new folder
 *   PATCH  /folders/:id                 → rename a folder (folder owner)
 *   DELETE /folders/:id                 → delete folder + all contained decks (folder owner; not "Drafts")
 *   POST   /folders/:id/move-decks      → bulk-move decks between folders (editor in both, owner of every deck)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   The caller's role in the folder (folder_permissions) is checked per request by
 *   the service: members read, editors change, the owner renames and deletes
 *   (docs/plans/folder-sharing.md).
 *
 * BYPASS_AUTH compatibility (dev mode):
 *   When BYPASS_AUTH=true, synthesized user is 'dev-user'.
 *   We also include 'demo-user' folders in GET /folders to expose legacy data, same as /decks.
 *   TODO(post-M10): remove demo-user fallback once production migration script runs.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { createFoldersService } from '../services/folders.js'
import { createDecksService } from '../services/decks.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'

/** Moved to services/folders.ts with the rest of the folder logic; re-exported for existing importers. */
export { getOrProvisionDrafts } from '../services/folders.js'

// ---------------------------------------------------------------------------
// Route registration — every handler calls the service the `folder.*` /
// `deck.*` agent commands call (services/folders.ts, services/decks.ts).
// ---------------------------------------------------------------------------

export async function registerFolderRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /folders — list folders for the authenticated user
  // -------------------------------------------------------------------------
  app.get('/folders', { preHandler: authPreHandler }, async (request, reply) => {
    try {
      const rows = await createFoldersService(routeDeps(app, db, request.log)).list({
        userId: request.user!.sub,
      })
      return reply.send(rows)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // POST /folders — create a new folder
  // -------------------------------------------------------------------------
  app.post<{ Body: { name?: unknown } }>(
    '/folders',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const created = await createFoldersService(routeDeps(app, db, request.log)).create({
          userId: request.user!.sub,
          name: request.body?.name as string,
        })
        return reply.status(201).send(created)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // PATCH /folders/:id — rename a folder (folder owner)
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/folders/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const updated = await createFoldersService(routeDeps(app, db, request.log)).rename({
          userId: request.user!.sub,
          folderId: request.params.id,
          name: request.body?.name as string,
        })
        return reply.send(updated)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /folders/:id — delete folder + all contained decks (cannot delete Drafts)
  //
  // M16 P1 follow-up: the UI double-confirms, so we cascade-delete decks
  // belonging to the folder. Drafts is still protected.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/folders/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const result = await createFoldersService(routeDeps(app, db, request.log)).delete({
          userId: request.user!.sub,
          folderId: request.params.id,
        })
        // 200 (not 204): a 204 No Content response MUST NOT carry a body, so
        // `deletedDeckCount` would be silently dropped.
        return reply.status(200).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /folders/:id/move-decks — bulk-move decks to a destination folder
  // Body: { deckIds: string[], destFolderId: string }
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string }
    Body: { deckIds?: unknown; destFolderId?: unknown }
  }>('/folders/:id/move-decks', { preHandler: authPreHandler }, async (request, reply) => {
    const { deckIds, destFolderId } = request.body ?? {}
    if (!Array.isArray(deckIds) || deckIds.length === 0) {
      return reply.status(400).send({ error: 'deckIds must be a non-empty array' })
    }
    if (typeof destFolderId !== 'string' || destFolderId === '') {
      return reply.status(400).send({ error: 'destFolderId is required' })
    }
    try {
      const result = await createDecksService(routeDeps(app, db, request.log)).moveDecks({
        userId: request.user!.sub,
        sourceFolderId: request.params.id,
        deckIds: deckIds as string[],
        destFolderId,
      })
      return reply.send(result)
    } catch (err) {
      return sendServiceError(reply, err)
    }
  })

  // -------------------------------------------------------------------------
  // GET /folders/:id/active-editors — who is currently editing each deck
  //
  // Returns one entry per deck in this folder that has at least one
  // active editor connected via Hocuspocus. Polled by the folder view to
  // render presence bubbles on each tile. Folder members only; below the
  // owner role, people come as names and pseudonyms (services/decks.ts).
  //
  // The caller IS included in the result. We deliberately don't filter
  // their own userId out: in BYPASS_AUTH dev mode every browser session
  // is 'dev-user' so filtering would erase all bubbles, and in prod the
  // owner having the deck open in a second tab is still useful info.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/folders/:id/active-editors',
    { preHandler: authPreHandler },
    async (request, reply) => {
      try {
        const entries = await createDecksService(routeDeps(app, db, request.log)).activeEditors({
          userId: request.user!.sub,
          folderId: request.params.id,
        })
        return reply.send(entries)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
