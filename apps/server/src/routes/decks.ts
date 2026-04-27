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
import type { Database } from '../db/client.js'
import { decks, deckPermissions } from '../db/schema.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import { resolveDeckAccess } from '../auth/permissions.js'

interface CreateDeckBody {
  title?: string
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

      return reply.send(rows)
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

    return reply.send(rows)
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

    return reply.send(deck)
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

      return reply.status(204).send()
    },
  )
}
