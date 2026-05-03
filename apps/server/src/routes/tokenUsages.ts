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
 */

import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import {
  folders,
  decks,
  components,
  deckUpdates,
  folderUpdates,
  componentUpdates,
} from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import {
  scanDeckDoc,
  scanComponentDoc,
  scanFolderDoc,
  type UsageEntry,
} from '@narrative/slide-model'
import { replayUpdates } from '../media/replayDoc.js'

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

      // Whitelist the token category at the boundary — anything else
      // would silently produce an empty result set against a fabricated
      // tokenKey, which is confusing for callers.
      const VALID_CATEGORIES = ['colors', 'textStyles', 'effectStyles'] as const
      type ValidCategory = (typeof VALID_CATEGORIES)[number]
      if (!(VALID_CATEGORIES as readonly string[]).includes(category)) {
        return reply.status(400).send({
          error: `Invalid token category. Allowed: ${VALID_CATEGORIES.join(', ')}`,
        })
      }
      const safeCategory = category as ValidCategory
      const userId = request.user!.sub

      // Verify folder exists and caller is the owner
      const [folder] = await db
        .select({ id: folders.id, ownerUserId: folders.ownerUserId })
        .from(folders)
        .where(eq(folders.id, folderId))
        .limit(1)

      if (!folder) {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (folder.ownerUserId !== userId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const tokenKey = `${safeCategory}.${tokenId}`
      const usages: UsageEntry[] = []

      // -----------------------------------------------------------------------
      // 1. Folder doc — textStyle color refs (only for colors category)
      // -----------------------------------------------------------------------
      if (safeCategory === 'colors') {
        const folderUpdateRows = await db
          .select({ update: folderUpdates.update })
          .from(folderUpdates)
          .where(eq(folderUpdates.folderId, folderId))
          .orderBy(folderUpdates.id)

        if (folderUpdateRows.length > 0) {
          const folderDoc = replayUpdates(folderUpdateRows)
          try {
            usages.push(...scanFolderDoc(folderDoc, tokenKey))
          } finally {
            folderDoc.destroy()
          }
        }
      }

      // -----------------------------------------------------------------------
      // 2. Decks in the folder
      // -----------------------------------------------------------------------
      const deckRows = await db
        .select({ id: decks.id, title: decks.title })
        .from(decks)
        .where(eq(decks.folderId, folderId))
        .orderBy(decks.createdAt)

      for (const deck of deckRows) {
        const updateRows = await db
          .select({ update: deckUpdates.update })
          .from(deckUpdates)
          .where(eq(deckUpdates.deckId, deck.id))
          .orderBy(deckUpdates.id)

        if (updateRows.length === 0) continue

        const deckDoc = replayUpdates(updateRows)
        try {
          usages.push(...scanDeckDoc(deckDoc, deck.id, deck.title, tokenKey))
        } finally {
          deckDoc.destroy()
        }
      }

      // -----------------------------------------------------------------------
      // 3. Components in the folder
      // -----------------------------------------------------------------------
      const componentRows = await db
        .select({ id: components.id, name: components.name })
        .from(components)
        .where(eq(components.folderId, folderId))
        .orderBy(components.createdAt)

      for (const component of componentRows) {
        const updateRows = await db
          .select({ update: componentUpdates.update })
          .from(componentUpdates)
          .where(eq(componentUpdates.componentId, component.id))
          .orderBy(componentUpdates.id)

        if (updateRows.length === 0) continue

        const componentDoc = replayUpdates(updateRows)
        try {
          usages.push(...scanComponentDoc(componentDoc, component.id, component.name, tokenKey))
        } finally {
          componentDoc.destroy()
        }
      }

      return reply.send({ usages })
    },
  )
}
