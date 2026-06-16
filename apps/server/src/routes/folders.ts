/**
 * routes/folders.ts
 *
 * REST API for folder management (M16 P1).
 *
 * Endpoints:
 *   GET    /folders                     → list folders for the authenticated user (with deck counts)
 *   POST   /folders                     → create a new folder
 *   PATCH  /folders/:id                 → rename a folder (owner only)
 *   DELETE /folders/:id                 → delete folder + all contained decks (cannot delete "Drafts")
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
import { eq, inArray, sql, and, or } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { folders, decks, mediaAssets } from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { purgeDeckBucketPrefix, purgeExplicitKeys } from '../media/bucketCleanup.js'
import { activeEditorsByDeck } from '../hocuspocus/presence.js'
import { listUsersBySubs } from '../auth/users.js'

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
  // DELETE /folders/:id — delete folder + all contained decks (cannot delete Drafts)
  //
  // M16 P1 follow-up: the UI double-confirms, so we cascade-delete decks
  // belonging to the folder. Drafts is still protected.
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

      // Capture deck ids so we can sweep MinIO blobs after the cascade.
      const containedDecks = await db
        .select({ id: decks.id })
        .from(decks)
        .where(eq(decks.folderId, id))
      const deckIds = containedDecks.map((d) => d.id)

      // Collect storage keys for every contained deck's assets AND the
      // folder's own fonts (deckId NULL, folderId = id) BEFORE the cascade
      // removes the media_assets rows. tus originals + folder fonts use a
      // compound storage key outside any decks/<id>/ prefix, so the prefix
      // sweep alone would orphan them.
      const assetRows = await db
        .select({
          storageKey: mediaAssets.storageKey,
          playbackKey: mediaAssets.playbackKey,
          posterKey: mediaAssets.posterKey,
          thumbnailKey: mediaAssets.thumbnailKey,
        })
        .from(mediaAssets)
        .where(
          deckIds.length > 0
            ? or(inArray(mediaAssets.deckId, deckIds), eq(mediaAssets.folderId, id))
            : eq(mediaAssets.folderId, id),
        )
      const explicitKeys = assetRows.flatMap((r) =>
        [r.storageKey, r.playbackKey, r.posterKey, r.thumbnailKey].filter(
          (k): k is string => typeof k === 'string' && k !== '',
        ),
      )

      // Delete decks first (FK is ON DELETE RESTRICT). Cascades remove
      // deck_updates / deck_permissions / share_links / media_assets rows.
      // Both deletes run in one transaction so a crash between them can't
      // leave the decks destroyed while the now-empty folder survives —
      // an unrecoverable partial delete of user data.
      await db.transaction(async (tx) => {
        if (containedDecks.length > 0) {
          await tx.delete(decks).where(eq(decks.folderId, id))
        }
        await tx.delete(folders).where(eq(folders.id, id))
      })

      // Best-effort MinIO cleanup. Pass 1: decks/<id>/ prefix sweep per
      // contained deck (thumbnails + worker video outputs). Pass 2:
      // explicit compound keys (tus originals + folder fonts + .info
      // sidecars). Loss-tolerant — errors are logged and swallowed.
      await Promise.all([
        ...containedDecks.map((d) => purgeDeckBucketPrefix(d.id, request.log)),
        purgeExplicitKeys(explicitKeys, request.log),
      ])

      // 200 (not 204): a 204 No Content response MUST NOT carry a body, so the
      // `deletedDeckCount` was being silently dropped. The client only checks
      // `res.ok`, so 200 is safe and actually delivers the count.
      return reply.status(200).send({ deletedDeckCount: containedDecks.length })
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

  // -------------------------------------------------------------------------
  // GET /folders/:id/active-editors — who is currently editing each deck
  //
  // Returns one entry per deck in this folder that has at least one
  // active editor connected via Hocuspocus. Polled by the folder view to
  // render presence bubbles on each tile. Owner-only.
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
      const { id: folderId } = request.params
      const userId = request.user!.sub

      const isBypass =
        (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts?.bypass === true

      // Verify folder ownership.
      const [owned] = await db
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.id, folderId),
            inArray(folders.ownerUserId, isBypass ? [userId, 'demo-user'] : [userId]),
          ),
        )
        .limit(1)
      if (!owned) {
        return reply.status(404).send({ error: 'Folder not found' })
      }

      const folderDecks = await db
        .select({ id: decks.id })
        .from(decks)
        .where(eq(decks.folderId, folderId))

      const snapshot = activeEditorsByDeck(folderDecks.map((d) => d.id))

      // Enrich each user id with display fields so the SPA can render
      // initials from email rather than from the opaque Google sub.
      // One IN-list lookup across the union of all subs.
      const uniqueSubs = Array.from(new Set(snapshot.flatMap((s) => s.userIds)))
      const usersList = await listUsersBySubs(db, uniqueSubs)
      const usersBySub = new Map(usersList.map((u) => [u.sub, u]))

      const enriched = snapshot.map((s) => ({
        deckId: s.deckId,
        users: s.userIds.map((sub) => {
          const u = usersBySub.get(sub)
          return {
            userId: sub,
            email: u?.email ?? null,
            name: u?.name ?? null,
          }
        }),
      }))

      return reply.send(enriched)
    },
  )
}
