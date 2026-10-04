/**
 * routes/sharing.ts
 *
 * Sharing management endpoints — permissions, pending email invites,
 * and share links for a deck. All endpoints require owner role.
 *
 * Endpoints:
 *   GET    /decks/:id/permissions         → list collaborators (enriched email+name)
 *   POST   /decks/:id/permissions         → invite { email, role }
 *                                             - if email belongs to a known user,
 *                                               grants directly (returns 200 {kind:'granted', user})
 *                                             - otherwise creates a pending invite
 *                                               (returns 201 {kind:'pending', invite})
 *   DELETE /decks/:id/permissions/:userId → revoke user (409 if last owner)
 *   GET    /decks/:id/invites             → list pending email invites
 *   DELETE /decks/:id/invites/:inviteId   → cancel pending invite
 *   GET    /decks/:id/share-links         → list active share links
 *   POST   /decks/:id/share-links         → create share link → { id, url }
 *   DELETE /decks/:id/share-links/:linkId → revoke share link
 *
 * Share link URL format: ${PUBLIC_URL}/deck/<deckId>?share_token=<id>
 * PUBLIC_URL env var must be set in production.
 *
 * Shared implementation: the handlers call services/sharing.ts — the same code the
 * `share.*` agent commands run (ADR 0010), so the two cannot drift apart.
 */

import type { FastifyInstance } from 'fastify'
import type { Database } from '../db/client.js'
import { authPreHandler, requireDeckRole } from '../auth/fastifyAuth.js'
import type { DeckRole } from '../auth/permissions.js'
import { createSharingService } from '../services/sharing.js'
import { routeDeps } from '../services/http.js'
import { sendServiceError } from '../services/errors.js'
import { inviteRouteRateLimit } from '../http/rateLimit.js'

// ---------------------------------------------------------------------------
// JSON schema helpers
// ---------------------------------------------------------------------------

const DECK_ROLE_VALUES = ['owner', 'editor', 'viewer'] as const

// RFC-5322-lite — good enough for an invite input. Real validation happens
// when the invitee successfully signs in via Google.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

const invitePermissionSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 320, pattern: EMAIL_PATTERN },
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
  // GET /decks/:id/permissions — enriched with email + name
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/permissions',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        return reply.send(
          await createSharingService(routeDeps(app, db, request.log)).listPermissions({
            deckId: request.params.id,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // POST /decks/:id/permissions — invite by email
  //
  // Behavior:
  //   - email is a registered user → grant immediately, return 200 with
  //     {kind:'granted', user:{userId,email,name,role}}.
  //   - email is unknown → create a pending invite, return 201 with
  //     {kind:'pending', invite:{id,email,role,expiresAt}}.
  //
  // Idempotency: re-inviting the same email replaces the existing pending
  // invite's role (handled inside `createInvite`); inviting an already-
  // granted user upserts the permission row (handled inside grantPermission
  // — it does an INSERT with ON CONFLICT DO UPDATE).
  // -------------------------------------------------------------------------
  app.post<{
    Params: { id: string }
    Body: { email: string; role: DeckRole }
  }>(
    '/decks/:id/permissions',
    { schema: invitePermissionSchema, preHandler: ownerGuard, config: inviteRouteRateLimit },
    async (request, reply) => {
      try {
        const result = await createSharingService(routeDeps(app, db, request.log)).invite({
          deckId: request.params.id,
          inviterUserId: request.user!.sub,
          email: request.body.email,
          role: request.body.role,
        })
        return reply.status(result.kind === 'granted' ? 200 : 201).send(result)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/permissions/:userId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; userId: string } }>(
    '/decks/:id/permissions/:userId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        await createSharingService(routeDeps(app, db, request.log)).revoke({
          deckId: request.params.id,
          callerUserId: request.user!.sub,
          userId: request.params.userId,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // GET /decks/:id/invites — pending email invites
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/invites',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        return reply.send(
          await createSharingService(routeDeps(app, db, request.log)).listInvites({
            deckId: request.params.id,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/invites/:inviteId — cancel pending invite
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/decks/:id/invites/:inviteId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        await createSharingService(routeDeps(app, db, request.log)).cancelInvite({
          deckId: request.params.id,
          inviteId: request.params.inviteId,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // GET /decks/:id/share-links
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/share-links',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        return reply.send(
          await createSharingService(routeDeps(app, db, request.log)).listLinks({
            deckId: request.params.id,
          }),
        )
      } catch (err) {
        return sendServiceError(reply, err)
      }
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
      try {
        const link = await createSharingService(routeDeps(app, db, request.log)).createLink({
          deckId: request.params.id,
          userId: request.user!.sub,
          role: request.body.role,
          expiresAt: request.body.expiresAt ?? null,
        })
        return reply.status(201).send(link)
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/share-links/:linkId
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; linkId: string } }>(
    '/decks/:id/share-links/:linkId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      try {
        await createSharingService(routeDeps(app, db, request.log)).revokeLink({
          deckId: request.params.id,
          linkId: request.params.linkId,
        })
        return reply.status(204).send()
      } catch (err) {
        return sendServiceError(reply, err)
      }
    },
  )
}
