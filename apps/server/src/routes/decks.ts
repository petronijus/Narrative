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
import { eq, inArray, sql } from 'drizzle-orm'
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import type { Database } from '../db/client.js'
import { decks, deckPermissions } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'

interface CreateDeckBody {
  title?: string
}

/** Hard cap on the data-URL payload — protects against giant uploads. */
const MAX_THUMBNAIL_BYTES = 1_000_000 // 1 MB after base64 decode

interface DeckRow {
  id: string
  title: string
  ownerUserId: string
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
  // ---------------------------------------------------------------------------
  app.get('/decks', { preHandler: authPreHandler }, async (request, reply) => {
    const userId = request.user!.sub

    // Determine if running in bypass/dev mode by checking bypass flag on plugin opts.
    const isBypass =
      (app as FastifyInstance & { _authOpts?: { bypass?: boolean } })._authOpts?.bypass === true

    if (isBypass) {
      // BYPASS_AUTH=true dev fallback: query both 'dev-user' and legacy 'demo-user' owned decks.
      // TODO(post-M10): remove when production migration script has run.
      const rows = await db
        .select()
        .from(decks)
        .where(inArray(decks.ownerUserId, ['dev-user', 'demo-user']))
        .orderBy(decks.createdAt)

      return reply.send(rows.map(withThumbnailUrl))
    }

    // Production: return decks where user has any explicit permission row.
    // Uses a subquery to avoid N+1 (deck.ownerUserId is already denormalized for fast lookup,
    // but deck_permissions is the authoritative access list post-M10).
    const accessibleDeckIds = db
      .select({ deckId: deckPermissions.deckId })
      .from(deckPermissions)
      .where(eq(deckPermissions.userId, userId))

    const rows = await db
      .select()
      .from(decks)
      .where(sql`${decks.id} IN (${accessibleDeckIds})`)
      .orderBy(decks.createdAt)

    return reply.send(rows.map(withThumbnailUrl))
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

    // Try JWT auth first (optional on this route).
    let userId: string | null = null
    const authHeader = request.headers['authorization']
    if (authHeader?.startsWith('Bearer ')) {
      const opts = (
        app as FastifyInstance & {
          _authOpts?: {
            verifier?: { verify: (t: string) => Promise<{ sub: string }> } | null
            bypass?: boolean
          }
        }
      )._authOpts
      if (opts?.bypass) {
        userId = 'dev-user'
      } else if (opts?.verifier) {
        try {
          const payload = await opts.verifier.verify(authHeader.slice(7))
          userId = payload.sub
        } catch {
          // Invalid token — fall through to share_token check
        }
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

    return reply.send(withThumbnailUrl(deck))
  })

  // ---------------------------------------------------------------------------
  // POST /decks — create new deck
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateDeckBody }>(
    '/decks',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const { title = 'Untitled Deck' } = request.body ?? {}
      const ownerUserId = request.user!.sub

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
    { preHandler: [authPreHandler, requireDeckRole('editor')] },
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

      // Capture the thumbnail key before deletion so we can also remove
      // the MinIO object — orphaned blobs would slowly fill the bucket.
      const [existing] = await db
        .select({ thumbnailKey: decks.thumbnailKey })
        .from(decks)
        .where(eq(decks.id, id))
        .limit(1)

      const deleted = await db.delete(decks).where(eq(decks.id, id)).returning({ id: decks.id })

      if (deleted.length === 0) {
        return reply.status(404).send({ error: 'Deck not found' })
      }

      if (existing?.thumbnailKey != null && existing.thumbnailKey !== '') {
        const s3 = buildS3Client()
        try {
          await s3.send(
            new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: existing.thumbnailKey }),
          )
        } catch (err) {
          // Storage failure is non-fatal — the DB row is gone, the
          // orphan can be reaped by a future cleanup pass.
          request.log.warn({ err, deckId: id }, 'thumbnail delete failed (orphan left)')
        }
      }

      return reply.status(204).send()
    },
  )
}
