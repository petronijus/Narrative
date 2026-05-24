/**
 * routes/decks.ts
 *
 * REST API for presentation (deck) management.
 *
 * Endpoints:
 *   GET    /decks      → list all decks accessible to the authenticated user
 *   POST   /decks      → create a new deck; ownerUserId = JWT sub claim
 *   DELETE /decks/:id  → delete deck (owner only)
 *   GET    /decks/:id  → get single deck (supports ?share_token=... for unauthenticated access)
 *
 * Auth:
 *   All endpoints require authPreHandler (JWT Bearer or BYPASS_AUTH=true dev mode).
 *   DELETE /decks/:id additionally requires requireDeckRole('owner').
 *   GET /decks/:id is the ONLY endpoint that accepts an unauthenticated share token.
 *     This is intentional: share links are read-only viewer access for specific decks.
 *
 * BYPASS_AUTH compatibility (dev mode):
 *   When BYPASS_AUTH=true, the synthesized user is 'dev-user'.
 *   Decks owned by legacy 'demo-user' (M4-era) would be invisible because they have
 *   no deck_permissions row for 'dev-user'.
 *   Workaround (Option A): GET /decks queries by BOTH ownerUserId IN ('demo-user', 'dev-user')
 *   when in bypass mode. Remove this when M10 ships to production and demo-user is migrated.
 *   TODO(post-M10): remove demo-user fallback once infra migration script runs in production.
 */

import type { FastifyInstance } from 'fastify'
import { nanoid } from 'nanoid'
import { eq, inArray, sql, and } from 'drizzle-orm'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { decks, deckPermissions, folders } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { lookupSession, SESSION_COOKIE_NAME } from '../auth/session.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { purgeDeckBucketPrefix } from '../media/bucketCleanup.js'
import { getOrProvisionDrafts } from './folders.js'

interface CreateDeckBody {
  title?: string
  folderId?: string
}

/**
 * Hard cap on the data-URL payload — protects against giant uploads.
 *
 * Sized for high-resolution slides with embedded photos. Pixi extracts
 * the thumbnail as PNG (lossless) so a 1920×1080 slide with a single
 * full-bleed photo lands in the 2-4 MB range; collage / poster decks
 * occasionally cross 4 MB. We picked 6 MB as a generous ceiling that
 * covers every real deck we've seen without inviting abuse (a 6 MB
 * PNG thumbnail is still under the per-deck media budget by orders
 * of magnitude).
 */
const MAX_THUMBNAIL_BYTES = 6 * 1024 * 1024

interface DeckRow {
  id: string
  title: string
  ownerUserId: string
  folderId: string
  thumbnailKey: string | null
  thumbnailUpdatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Decorates a deck row with a signed imgproxy thumbnail URL so the home
 * page can render previews without exposing the underlying MinIO key.
 * The `?v=<ms>` query string busts client + imgproxy caches whenever
 * the editor uploads a fresh snapshot.
 */
function withThumbnailUrl(row: DeckRow): DeckRow & { thumbnailUrl: string | null } {
  let thumbnailUrl: string | null = null
  if (row.thumbnailKey !== null) {
    const base = signImgproxyUrl({
      storageKey: row.thumbnailKey,
      variant: 'thumb',
      extension: 'jpg',
    })
    const v = row.thumbnailUpdatedAt?.getTime() ?? 0
    thumbnailUrl = v > 0 ? `${base}?v=${v}` : base
  }
  return { ...row, thumbnailUrl }
}

/**
 * Parse a `data:image/(jpeg|png);base64,XXXX` URL into its mime + bytes.
 * Returns null on any parse failure or unsupported mime.
 */
function parseDataUrl(input: string): { mime: 'image/jpeg' | 'image/png'; bytes: Buffer } | null {
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(input)
  if (m === null) return null
  const mime = m[1] as 'image/jpeg' | 'image/png'
  let bytes: Buffer
  try {
    bytes = Buffer.from(m[2] ?? '', 'base64')
  } catch {
    return null
  }
  if (bytes.byteLength === 0) return null
  return { mime, bytes }
}

export async function registerDeckRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // ---------------------------------------------------------------------------
  // GET /decks — list decks accessible to the authenticated user
  //
  // Optional query param: ?folderId=<id>
  //   When provided, returns only decks in that folder. Folder ownership is
  //   verified; attempting to filter by another user's folder returns 403.
  // ---------------------------------------------------------------------------
  app.get('/decks', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = request.user!.sub
    const query = request.query as Record<string, string>
    const filterFolderId = query['folderId'] ?? null

    // Determine if running in bypass/dev mode by checking bypass flag on plugin opts.
    const isBypass =
      (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts?.bypass === true

    // If a folder filter was requested, verify the caller owns that folder.
    if (filterFolderId !== null) {
      const [folder] = await db
        .select({ ownerUserId: folders.ownerUserId })
        .from(folders)
        .where(eq(folders.id, filterFolderId))
        .limit(1)

      if (!folder) {
        return reply.status(404).send({ error: 'Folder not found' })
      }

      // In bypass mode the synthesized userId is 'dev-user'; also allow demo-user's folders.
      const allowedOwners = isBypass ? [userId, 'demo-user'] : [userId]
      if (!allowedOwners.includes(folder.ownerUserId)) {
        return reply.status(403).send({ error: 'Forbidden' })
      }
    }

    if (isBypass) {
      // BYPASS_AUTH=true dev fallback: query both 'dev-user' and legacy 'demo-user' owned decks.
      // TODO(post-M10): remove when production migration script has run.
      const ownerCondition = inArray(decks.ownerUserId, ['dev-user', 'demo-user'])
      const whereClause =
        filterFolderId !== null
          ? and(ownerCondition, eq(decks.folderId, filterFolderId))
          : ownerCondition

      const rows = await db.select().from(decks).where(whereClause).orderBy(decks.createdAt)
      // In bypass mode dev-user always has owner role on their own decks.
      return reply.send(rows.map((r) => ({ ...withThumbnailUrl(r), viewerRole: 'owner' as const })))
    }

    // Production: return decks where user has any explicit permission row.
    // Uses a subquery to avoid N+1 (deck.ownerUserId is already denormalized for fast lookup,
    // but deck_permissions is the authoritative access list post-M10).
    const accessibleDeckIds = db
      .select({ deckId: deckPermissions.deckId })
      .from(deckPermissions)
      .where(eq(deckPermissions.userId, userId))

    const accessCondition = sql`${decks.id} IN (${accessibleDeckIds})`
    const whereClause =
      filterFolderId !== null
        ? and(accessCondition, eq(decks.folderId, filterFolderId))
        : accessCondition

    const rows = await db.select().from(decks).where(whereClause).orderBy(decks.createdAt)

    // Stamp each row with the caller's effective role on that deck. One
    // small follow-up query — typically <50 decks — much cheaper than the
    // alternative (a CTE + window function in the main query) and easier
    // to read.
    const rolesByDeck = new Map<string, 'owner' | 'editor' | 'viewer'>()
    if (rows.length > 0) {
      const permRows = await db
        .select({ deckId: deckPermissions.deckId, role: deckPermissions.role })
        .from(deckPermissions)
        .where(
          and(
            eq(deckPermissions.userId, userId),
            inArray(
              deckPermissions.deckId,
              rows.map((r) => r.id),
            ),
          ),
        )
      for (const p of permRows) rolesByDeck.set(p.deckId, p.role as 'owner' | 'editor' | 'viewer')
    }

    return reply.send(
      rows.map((r) => ({
        ...withThumbnailUrl(r),
        // Default to viewer if no permission row was found (shouldn't happen
        // — the IN clause guarantees one exists — but defensive).
        viewerRole: rolesByDeck.get(r.id) ?? 'viewer',
      })),
    )
  })

  // ---------------------------------------------------------------------------
  // GET /decks/:id — get single deck (supports share_token)
  //
  // This is the ONE endpoint that supports unauthenticated access via share token.
  // authPreHandler is NOT listed here; we handle auth manually to allow share links.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/decks/:id', async (request, reply) => {
    const { id } = request.params
    const query = request.query as Record<string, string>
    const shareToken = query['share_token'] ?? null

    // Auth is optional on this route — falls through to the share-token
    // check below if no session cookie. authPreHandler isn't listed in
    // preHandler because we want the share-token path to work for
    // unauthenticated viewers.
    let userId: string | null = null
    const opts = (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts
    if (opts?.bypass) {
      userId = 'dev-user'
    } else {
      const rawSessionId = request.cookies?.[SESSION_COOKIE_NAME]
      if (rawSessionId) {
        const session = await lookupSession(db, rawSessionId)
        if (session) userId = session.userSub
      }
    }

    const access = await resolveDeckAccess(db, { deckId: id, userId, shareToken })
    if (!access) {
      return reply.status(403).send({ error: 'Forbidden' })
    }

    const [deck] = await db.select().from(decks).where(eq(decks.id, id)).limit(1)

    if (!deck) {
      return reply.status(404).send({ error: 'Deck not found' })
    }

    return reply.send({ ...withThumbnailUrl(deck), viewerRole: access.role })
  })

  // ---------------------------------------------------------------------------
  // POST /decks — create new deck
  //
  // Optional body fields:
  //   folderId — if provided, deck is created in that folder (must be owned by caller).
  //              If absent, defaults to the caller's "Drafts" folder (auto-provisioned if needed).
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateDeckBody }>(
    '/decks',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { title = 'Untitled Deck', folderId: requestedFolderId } = request.body ?? {}
      const ownerUserId = request.user!.sub

      // Resolve the target folder — verify ownership when explicitly provided.
      let targetFolderId: string
      if (requestedFolderId) {
        const [folder] = await db
          .select({ id: folders.id, ownerUserId: folders.ownerUserId })
          .from(folders)
          .where(eq(folders.id, requestedFolderId))
          .limit(1)

        if (!folder) {
          return reply.status(404).send({ error: 'Folder not found' })
        }
        if (folder.ownerUserId !== ownerUserId) {
          return reply.status(403).send({ error: 'Forbidden' })
        }
        targetFolderId = folder.id
      } else {
        // Auto-provision Drafts if the user doesn't have one yet.
        targetFolderId = await getOrProvisionDrafts(db, ownerUserId)
      }

      const id = nanoid(12)
      const now = new Date()

      // Transactional: insert deck + owner permission row together.
      // This keeps decks.owner_user_id and deck_permissions in sync from the start.
      const deck = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(decks)
          .values({
            id,
            title,
            ownerUserId,
            folderId: targetFolderId,
            createdAt: now,
            updatedAt: now,
          })
          .returning()

        if (!inserted) return null

        await tx.insert(deckPermissions).values({
          deckId: id,
          userId: ownerUserId,
          role: 'owner',
          grantedAt: now,
          grantedBy: ownerUserId,
        })

        return inserted
      })

      if (!deck) {
        return reply.status(500).send({ error: 'Failed to create deck' })
      }

      return reply.status(201).send(deck)
    },
  )

  // ---------------------------------------------------------------------------
  // PATCH /decks/:id — rename deck (owner or editor)
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: { title?: string } }>(
    '/decks/:id',
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
    async (request, reply) => {
      const { id } = request.params
      const title = request.body?.title?.trim()
      if (title === undefined || title === '') {
        return reply.status(400).send({ error: 'title is required' })
      }
      if (title.length > 200) {
        return reply.status(400).send({ error: 'title too long (max 200)' })
      }

      const [updated] = await db
        .update(decks)
        .set({ title, updatedAt: new Date() })
        .where(eq(decks.id, id))
        .returning()

      if (!updated) {
        return reply.status(404).send({ error: 'Deck not found' })
      }
      return reply.send(updated)
    },
  )

  // ---------------------------------------------------------------------------
  // PUT /decks/:id/thumbnail — upload deck preview snapshot (editor or owner)
  //
  // Accepts a JSON body { dataUrl: "data:image/(jpeg|png);base64,..." }.
  // The dataUrl format matches what the editor already keeps in the
  // localStorage cache (`narrative:deckThumbs`), so the client can pipe
  // the same blob to the server without re-rendering. Decoded bytes are
  // capped at MAX_THUMBNAIL_BYTES to bound storage + bandwidth.
  // ---------------------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { dataUrl?: unknown } }>(
    '/decks/:id/thumbnail',
    {
      preHandler: [authPreHandler, requireDeckRole('editor')],
      // Per-route override of Fastify's 4 MB global bodyLimit. The dataUrl
      // payload is base64-encoded (1.34× the decoded size) plus a thin
      // JSON wrapper, so the JSON body lands at ≈ MAX_THUMBNAIL_BYTES * 1.4
      // + a few bytes of overhead. Round up to MAX_THUMBNAIL_BYTES * 1.5
      // so Fastify lets the request through to our route's own decoded-
      // bytes check (which returns a structured `{error: "thumbnail too
      // large"}` rather than the bare `Content too large` Fastify writes
      // when its global limit hits first).
      bodyLimit: Math.floor(MAX_THUMBNAIL_BYTES * 1.5) + 1024,
    },
    async (request, reply) => {
      const { id } = request.params
      const dataUrlRaw = request.body?.dataUrl
      if (typeof dataUrlRaw !== 'string' || dataUrlRaw === '') {
        return reply.status(400).send({ error: 'dataUrl is required' })
      }
      const parsed = parseDataUrl(dataUrlRaw)
      if (parsed === null) {
        return reply
          .status(400)
          .send({ error: 'dataUrl must be a base64 data: URL of image/jpeg or image/png' })
      }
      if (parsed.bytes.byteLength > MAX_THUMBNAIL_BYTES) {
        return reply.status(413).send({ error: 'thumbnail too large' })
      }

      // The deck's MinIO key is stable per deck — overwriting the same
      // object lets imgproxy / browser caches key on the
      // thumbnail_updated_at timestamp returned in the deck row.
      const ext = parsed.mime === 'image/png' ? 'png' : 'jpg'
      const storageKey = `decks/${id}/thumb.${ext}`
      const s3 = buildS3Client()
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: MEDIA_BUCKET,
            Key: storageKey,
            Body: parsed.bytes,
            ContentType: parsed.mime,
            CacheControl: 'public, max-age=60',
          }),
        )
      } catch (err) {
        request.log.error({ err, deckId: id }, 'thumbnail upload failed')
        return reply.status(502).send({ error: 'storage upload failed' })
      }

      const now = new Date()
      const [updated] = await db
        .update(decks)
        .set({ thumbnailKey: storageKey, thumbnailUpdatedAt: now, updatedAt: now })
        .where(eq(decks.id, id))
        .returning()
      if (!updated) {
        return reply.status(404).send({ error: 'Deck not found' })
      }
      return reply.send(withThumbnailUrl(updated))
    },
  )

  // ---------------------------------------------------------------------------
  // DELETE /decks/:id — delete deck (owner only)
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/decks/:id',
    { preHandler: [authPreHandler, requireDeckRole('owner')] },
    async (request, reply) => {
      const { id } = request.params

      const deleted = await db.delete(decks).where(eq(decks.id, id)).returning({ id: decks.id })

      if (deleted.length === 0) {
        return reply.status(404).send({ error: 'Deck not found' })
      }

      // Sweep MinIO under decks/<id>/. Covers the deck thumbnail, every
      // media_assets original (image / audio / video / PPTX-import), the
      // HLS bundle for transcoded videos (including untracked segment
      // files), and any folder fonts that were uploaded against the
      // deck. Loss-tolerant: errors are logged and swallowed.
      await purgeDeckBucketPrefix(id, request.log)

      return reply.status(204).send()
    },
  )
}
