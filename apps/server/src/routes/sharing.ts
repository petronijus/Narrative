/**
 * routes/sharing.ts
 *
 * Sharing management endpoints — permissions and share links for a deck.
 *
 * All endpoints require:
 *   1. authPreHandler — valid JWT (or dev bypass)
 *   2. requireDeckRole('owner') — only deck owners can manage sharing
 *
 * Endpoints:
 *   GET    /decks/:id/permissions         → list users + roles
 *   POST   /decks/:id/permissions         → grant { userId, role }
 *   DELETE /decks/:id/permissions/:userId → revoke user (409 if last owner)
 *   GET    /decks/:id/share-links         → list active share links
 *   POST   /decks/:id/share-links         → create share link → { id, url }
 *   DELETE /decks/:id/share-links/:linkId → revoke share link
 *
 * Share link URL format: ${PUBLIC_URL}/deck/<deckId>?share_token=<id>
 * PUBLIC_URL env var must be set in production. Falls back to a relative-style path.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import {
  grantPermission,
  revokePermission,
  listPermissions,
  type DeckRole,
} from '../auth/permissions.js'
import { createShareLink, revokeShareLink, listShareLinks } from '../auth/shareLinks.js'
import { and, eq } from 'drizzle-orm'
import { deckPermissions } from '../db/schema.js'

// ---------------------------------------------------------------------------
// JSON schema helpers
// ---------------------------------------------------------------------------

const DECK_ROLE_VALUES = ['owner', 'editor', 'viewer'] as const

const grantPermissionSchema = {
  body: {
    type: 'object',
    required: ['userId', 'role'],
    additionalProperties: false,
    properties: {
      userId: { type: 'string', minLength: 1 },
      role: { type: 'string', enum: DECK_ROLE_VALUES },
    },
  },
}

const createShareLinkSchema = {
  body: {
    type: 'object',
    required: ['role'],
    additionalProperties: false,
    properties: {
      role: { type: 'string', enum: DECK_ROLE_VALUES },
      expiresAt: { type: 'string', format: 'date-time' },
    },
  },
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export async function registerSharingRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const ownerGuard = [authPreHandler, requireDeckRole('owner')]

  // -------------------------------------------------------------------------
  // GET /decks/:id/permissions
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/permissions',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const permissions = await listPermissions(db, id)
      return reply.send(permissions)
    },
  )

  // -------------------------------------------------------------------------
  // POST /decks/:id/permissions
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string }
    Body: { userId: string; role: DeckRole }
  }>(
    '/decks/:id/permissions',
    { schema: grantPermissionSchema, preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const { userId, role } = request.body

      await grantPermission(db, {
        deckId: id,
        userId,
        role,
        grantedBy: request.user!.sub,
      })

      return reply.status(204).send()
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/permissions/:userId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; userId: string } }>(
    '/decks/:id/permissions/:userId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id, userId } = request.params

      // Safeguard: refuse to revoke the last owner.
      // Count remaining owners after hypothetical revoke.
      const owners = await db
        .select({ userId: deckPermissions.userId })
        .from(deckPermissions)
        .where(and(eq(deckPermissions.deckId, id), eq(deckPermissions.role, 'owner')))

      const isTargetOwner = owners.some((o) => o.userId === userId)
      if (isTargetOwner && owners.length <= 1) {
        return reply
          .status(409)
          .send({ error: 'Cannot revoke the last owner — assign another owner first.' })
      }

      await revokePermission(db, { deckId: id, userId })
      return reply.status(204).send()
    },
  )

  // -------------------------------------------------------------------------
  // GET /decks/:id/share-links
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/share-links',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const links = await listShareLinks(db, id)
      // Return only non-revoked links to reduce noise; callers can request all if needed.
      return reply.send(links.filter((l) => !l.revoked))
    },
  )

  // -------------------------------------------------------------------------
  // POST /decks/:id/share-links
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string }
    Body: { role: DeckRole; expiresAt?: string }
  }>(
    '/decks/:id/share-links',
    { schema: createShareLinkSchema, preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const { role, expiresAt: expiresAtStr } = request.body

      const expiresAt = expiresAtStr ? new Date(expiresAtStr) : null

      const link = await createShareLink(db, {
        deckId: id,
        role,
        createdBy: request.user!.sub,
        expiresAt,
      })

      const publicUrl = process.env['PUBLIC_URL'] ?? ''
      const url = `${publicUrl}/deck/${id}?share_token=${link.id}`

      return reply.status(201).send({ id: link.id, url })
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/share-links/:linkId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; linkId: string } }>(
    '/decks/:id/share-links/:linkId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id, linkId } = request.params
      await revokeShareLink(db, linkId, id)
      return reply.status(204).send()
    },
  )
}
