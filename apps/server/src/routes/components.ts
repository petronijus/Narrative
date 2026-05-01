/**
 * routes/components.ts
 *
 * REST API for component master management (M16 P5).
 *
 * Endpoints:
 *   GET    /folders/:folderId/components   → list components in a folder (owner only)
 *   POST   /folders/:folderId/components   → create a component row (Y.Doc created lazily by Hocuspocus)
 *   PATCH  /components/:id                 → rename (owner only)
 *   DELETE /components/:id                 → delete (owner only; cascades component_updates)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   Ownership verified via folders.owner_user_id.
 *
 * Thumbnail:
 *   Mirrors the deck thumbnail pattern — NULL until the editor uploads a snapshot.
 *   Served via signImgproxyUrl exactly as deck thumbnails are.
 */

import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { components, folders } from '../db/schema.js'
import { authPreHandler } from '../auth/fastifyAuth.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentRow {
  id: string
  folderId: string
  name: string
  thumbnailKey: string | null
  createdAt: Date
  updatedAt: Date
}

function withThumbnailUrl(row: ComponentRow): ComponentRow & { thumbnailUrl: string | null } {
  let thumbnailUrl: string | null = null
  if (row.thumbnailKey !== null) {
    thumbnailUrl = signImgproxyUrl({
      storageKey: row.thumbnailKey,
      variant: 'thumb',
      extension: 'jpg',
    })
  }
  return { ...row, thumbnailUrl }
}

// ---------------------------------------------------------------------------
// Ownership check helper
// ---------------------------------------------------------------------------

/**
 * Verifies that a folder exists and is owned by userId.
 * Returns the folder row on success, or null / 'forbidden' on failure.
 */
async function checkFolderOwner(
  db: Database,
  folderId: string,
  userId: string,
): Promise<{ id: string } | 'not_found' | 'forbidden'> {
  const [row] = await db
    .select({ id: folders.id, ownerUserId: folders.ownerUserId })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)

  if (!row) return 'not_found'
  if (row.ownerUserId !== userId) return 'forbidden'
  return { id: row.id }
}

/**
 * Verifies that a component exists and that userId owns its folder.
 */
async function checkComponentOwner(
  db: Database,
  componentId: string,
  userId: string,
): Promise<{ id: string; folderId: string } | 'not_found' | 'forbidden'> {
  const [row] = await db
    .select({ id: components.id, folderId: components.folderId })
    .from(components)
    .where(eq(components.id, componentId))
    .limit(1)

  if (!row) return 'not_found'

  const folderResult = await checkFolderOwner(db, row.folderId, userId)
  if (folderResult === 'not_found' || folderResult === 'forbidden') return 'forbidden'

  return { id: row.id, folderId: row.folderId }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerComponentRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /folders/:folderId/components — list components in a folder
  // -------------------------------------------------------------------------
  app.get<{ Params: { folderId: string } }>(
    '/folders/:folderId/components',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { folderId } = request.params
      const userId = request.user!.sub

      const folderResult = await checkFolderOwner(db, folderId, userId)
      if (folderResult === 'not_found') {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (folderResult === 'forbidden') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const rows = await db
        .select()
        .from(components)
        .where(eq(components.folderId, folderId))
        .orderBy(components.createdAt)

      return reply.send(rows.map(withThumbnailUrl))
    },
  )

  // -------------------------------------------------------------------------
  // POST /folders/:folderId/components — create a component
  //
  // Body: { name?: string, id?: string }
  // The Y.Doc is created lazily by Hocuspocus on first connect.
  // -------------------------------------------------------------------------
  app.post<{ Params: { folderId: string }; Body: { name?: unknown; id?: unknown } }>(
    '/folders/:folderId/components',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { folderId } = request.params
      const userId = request.user!.sub

      const folderResult = await checkFolderOwner(db, folderId, userId)
      if (folderResult === 'not_found') {
        return reply.status(404).send({ error: 'Folder not found' })
      }
      if (folderResult === 'forbidden') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const rawName = (request.body?.name as string | undefined)?.trim()
      const name = rawName && rawName.length > 0 ? rawName : 'Untitled component'

      // Caller (editor-ui promote flow) may pass a pre-generated id so the
      // component doc and the Postgres row share the same id without a
      // round-trip. Falls back to a fresh nanoid(12).
      const rawId = request.body?.id
      const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : nanoid(12)

      const now = new Date()
      const [created] = await db
        .insert(components)
        .values({ id, folderId, name, createdAt: now, updatedAt: now })
        .returning()

      if (!created) {
        return reply.status(500).send({ error: 'Failed to create component' })
      }

      return reply.status(201).send(withThumbnailUrl(created))
    },
  )

  // -------------------------------------------------------------------------
  // PATCH /components/:id — rename (owner only)
  //
  // Body: { name?: string }
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>(
    '/components/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user!.sub

      const componentResult = await checkComponentOwner(db, id, userId)
      if (componentResult === 'not_found') {
        return reply.status(404).send({ error: 'Component not found' })
      }
      if (componentResult === 'forbidden') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const rawName = (request.body?.name as string | undefined)?.trim()
      if (!rawName || rawName.length === 0) {
        return reply.status(400).send({ error: 'name is required' })
      }
      if (rawName.length > 200) {
        return reply.status(400).send({ error: 'name too long (max 200)' })
      }

      const [updated] = await db
        .update(components)
        .set({ name: rawName, updatedAt: new Date() })
        .where(eq(components.id, id))
        .returning()

      if (!updated) {
        return reply.status(404).send({ error: 'Component not found' })
      }

      return reply.send(withThumbnailUrl(updated))
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /components/:id — delete component + cascade component_updates
  //
  // The caller (UI) is responsible for replacing or removing instances on slides.
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/components/:id',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { id } = request.params
      const userId = request.user!.sub

      const componentResult = await checkComponentOwner(db, id, userId)
      if (componentResult === 'not_found') {
        return reply.status(404).send({ error: 'Component not found' })
      }
      if (componentResult === 'forbidden') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // component_updates cascade-delete via FK ON DELETE CASCADE.
      await db.delete(components).where(eq(components.id, id))

      return reply.status(204).send()
    },
  )
}
