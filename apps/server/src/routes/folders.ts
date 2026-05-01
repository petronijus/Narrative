/**
 * routes/folders.ts
 *
 * REST API for folder management (M16 P1).
 *
 * Endpoints:
 *   GET    /folders                     → list folders for the authenticated user (with deck counts)
 *   POST   /folders                     → create a new folder
 *   PATCH  /folders/:id                 → rename a folder (owner only)
 *   DELETE /folders/:id                 → delete folder (only if empty; cannot delete "Drafts")
 *   POST   /folders/:id/move-decks      → bulk-move decks between folders (caller must own all)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   Ownership is verified per-request against folders.owner_user_id.
 *
 * BYPASS_AUTH compatibility (dev mode):
 *   When BYPASS_AUTH=true, synthesized user is 'dev-user'.
 *   We also include 'demo-user' folders in GET /folders to expose legacy data, same as /decks.
 *   TODO(post-M10): remove demo-user fallback once production migration script runs.
 */

import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { eq, inArray, sql, and } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { folders, decks } from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable "Drafts" folder id from a user id.
 * Mirrors the SQL expression in the migration: 'drafts-' || md5(owner_user_id).
 *
 * We replicate the same algorithm here so we never have to do a DB lookup just
 * to find a user's Drafts folder id during deck creation.
 */
function draftsFolderIdForUser(userId: string): string {
  // Use nanoid-based stable id stored in DB — we cannot reproduce md5 in TS
  // without a dependency; instead we SELECT from DB when we need it.
  // This function is intentionally left as a marker; actual lookup goes through
  // getOrProvisionDrafts().
  void userId
  throw new Error('Use getOrProvisionDrafts() instead')
}
// Suppress the unused warning
void draftsFolderIdForUser

/**
 * Find or create the "Drafts" folder for a given user.
 * On first deck creation for a brand-new user (no existing folders), this
 * auto-provisions the Drafts folder.
 */
export async function getOrProvisionDrafts(db: Database, userId: string): Promise<string> {
  // Look for an existing Drafts folder owned by this user
  const [existing] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.ownerUserId, userId), eq(folders.name, 'Drafts')))
    .limit(1)

  if (existing) return existing.id

  // Auto-provision
  const id = nanoid(12)
  const [created] = await db
    .insert(folders)
    .values({ id, ownerUserId: userId, name: 'Drafts', createdAt: new Date() })
    .returning({ id: folders.id })

  if (!created) throw new Error('Failed to provision Drafts folder')
  return created.id
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerFolderRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /folders — list folders for the authenticated user
  // -------------------------------------------------------------------------
  app.get('/folders', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = request.user!.sub

    const isBypass =
      (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts?.bypass === true

    // Determine which user ids to query (bypass includes legacy demo-user)
    const ownerIds = isBypass ? [userId, 'demo-user'] : [userId]

    // Subquery: count decks per folder
    const deckCountSub = db
      .select({
        folderId: decks.folderId,
        count: sql<number>`cast(count(*) as int)`.as('count'),
      })
      .from(decks)
      .groupBy(decks.folderId)
      .as('deck_counts')

    const rows = await db
      .select({
        id: folders.id,
        name: folders.name,
        createdAt: folders.createdAt,
        deckCount: sql<number>`coalesce(${deckCountSub.count}, 0)`,
      })
      .from(folders)
      .leftJoin(deckCountSub, eq(folders.id, deckCountSub.folderId))
      .where(inArray(folders.ownerUserId, ownerIds))
      .orderBy(folders.createdAt)

    return reply.send(rows)
  })

  // -------------------------------------------------------------------------
  // POST /folders — create a new folder
  // -------------------------------------------------------------------------
  app.post<{ Body: { name?: unknown } }>(
    '/folders',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const userId = request.user!.sub
      const name = (request.body?.name as string | undefined)?.trim()

      if (!name || name === '') {
        return reply.status(400).send({ error: 'name is required' })
      }
      if (name.length > 200) {
        return reply.status(400).send({ error: 'name too long (max 200)' })
      }

      const id = nanoid(12)
      const [created] = await db
        .insert(folders)
        .values({ id, ownerUserId: userId, name, createdAt: new Date() })
        .returning()

      if (!created) {
        return reply.status(500).send({ error: 'Failed to create folder' })
      }

      return reply.status(201).send({ ...created, deckCount: 0 })
    },
  )

  // -------------------------------------------------------------------------
  // PATCH /folders/:id — rename a folder (owner only)
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/folders/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user!.sub
      const name = (request.body?.name as string | undefined)?.trim()

      if (!name || name === '') {
        return reply.status(400).send({ error: 'name is required' })
      }
      if (name.length > 200) {
        return reply.status(400).send({ error: 'name too long (max 200)' })
      }

      // Verify ownership
      const [existing] = await db
        .select({ id: folders.id, ownerUserId: folders.ownerUserId })
        .from(folders)
        .where(eq(folders.id, id))
        .limit(1)

      if (!existing) {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (existing.ownerUserId !== userId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const [updated] = await db.update(folders).set({ name }).where(eq(folders.id, id)).returning()

      return reply.send(updated)
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /folders/:id — delete folder (empty only; cannot delete Drafts)
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/folders/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user!.sub

      const [existing] = await db
        .select({ id: folders.id, ownerUserId: folders.ownerUserId, name: folders.name })
        .from(folders)
        .where(eq(folders.id, id))
        .limit(1)

      if (!existing) {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (existing.ownerUserId !== userId) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Prevent deleting the "Drafts" folder
      if (existing.name === 'Drafts') {
        return reply.status(409).send({ error: 'cannot_delete_drafts' })
      }

      // Check if folder has any decks
      const [countRow] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(decks)
        .where(eq(decks.folderId, id))

      const deckCount = countRow?.count ?? 0
      if (deckCount > 0) {
        return reply.status(409).send({ error: 'folder_not_empty', deckCount })
      }

      await db.delete(folders).where(eq(folders.id, id))
      return reply.status(204).send()
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
    const { id: srcFolderId } = request.params
    const userId = request.user!.sub
    const { deckIds, destFolderId } = request.body ?? {}

    if (!Array.isArray(deckIds) || deckIds.length === 0) {
      return reply.status(400).send({ error: 'deckIds must be a non-empty array' })
    }
    if (typeof destFolderId !== 'string' || destFolderId === '') {
      return reply.status(400).send({ error: 'destFolderId is required' })
    }

    const ids = deckIds as string[]

    // Verify source folder ownership
    const [srcFolder] = await db
      .select({ id: folders.id, ownerUserId: folders.ownerUserId })
      .from(folders)
      .where(eq(folders.id, srcFolderId))
      .limit(1)

    if (!srcFolder) {
      return reply.status(404).send({ error: 'Source folder not found' })
    }
    if (srcFolder.ownerUserId !== userId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // Verify destination folder ownership
    const [destFolder] = await db
      .select({ id: folders.id, ownerUserId: folders.ownerUserId })
      .from(folders)
      .where(eq(folders.id, destFolderId))
      .limit(1)

    if (!destFolder) {
      return reply.status(404).send({ error: 'Destination folder not found' })
    }
    if (destFolder.ownerUserId !== userId) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    // Verify all specified decks belong to the caller and are in the source folder
    const deckRows = await db
      .select({ id: decks.id, ownerUserId: decks.ownerUserId, folderId: decks.folderId })
      .from(decks)
      .where(inArray(decks.id, ids))

    const unauthorized = deckRows.filter((d) => d.ownerUserId !== userId)
    if (unauthorized.length > 0) {
      return reply.status(403).send({ error: 'Forbidden: some decks are not owned by you' })
    }

    const notInSrc = deckRows.filter((d) => d.folderId !== srcFolderId)
    if (notInSrc.length > 0) {
      return reply
        .status(400)
        .send({ error: 'Some decks are not in the source folder', count: notInSrc.length })
    }

    if (deckRows.length !== ids.length) {
      return reply.status(400).send({ error: 'Some deck ids not found' })
    }

    // Move
    const result = await db
      .update(decks)
      .set({ folderId: destFolderId, updatedAt: new Date() })
      .where(inArray(decks.id, ids))
      .returning({ id: decks.id })

    return reply.send({ movedCount: result.length })
  })
}
