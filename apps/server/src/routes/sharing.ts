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
import { createInvite, listPendingInvitesForDeck, revokeInvite } from '../auth/invites.js'
import { getUserByEmail, getUserBySub, listUsersBySubs } from '../auth/users.js'
import { sendEmail } from '../email/client.js'
import { renderDeckInviteEmail } from '../email/templates/deckInvite.js'
import { and, eq } from 'drizzle-orm'
import { decks, deckPermissions } from '../db/schema.js'

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
      const { id } = request.params
      const permissions = await listPermissions(db, id)

      // Enrich each row with display fields from `users`. One round-trip via
      // an IN list — typically <10 collaborators per deck.
      const subs = permissions.map((p) => p.userId)
      const usersList = await listUsersBySubs(db, subs)
      const usersBySub = new Map(usersList.map((u) => [u.sub, u]))

      const enriched = permissions.map((p) => {
        const u = usersBySub.get(p.userId)
        return {
          userId: p.userId,
          role: p.role,
          grantedAt: p.grantedAt,
          grantedBy: p.grantedBy,
          // Fall back to sub if the directory row is missing (shouldn't
          // happen post-migration, but defensive).
          email: u?.email ?? null,
          name: u?.name ?? null,
        }
      })

      return reply.send(enriched)
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
    { schema: invitePermissionSchema, preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const { email, role } = request.body
      const inviterSub = request.user!.sub

      const existingUser = await getUserByEmail(db, email)

      if (existingUser) {
        await grantPermission(db, {
          deckId: id,
          userId: existingUser.sub,
          role,
          grantedBy: inviterSub,
        })
        return reply.status(200).send({
          kind: 'granted',
          user: {
            userId: existingUser.sub,
            email: existingUser.email,
            name: existingUser.name,
            role,
          },
        })
      }

      const invite = await createInvite(db, {
        deckId: id,
        email,
        role,
        invitedBySub: inviterSub,
      })

      // Fire-and-forget invite email. The DB row is already created, so
      // the invitee can still be onboarded by hand even if delivery fails.
      // We resolve deck title + inviter display name here so the template
      // reads like a personal note rather than a system blast.
      void (async () => {
        try {
          const [deckRow] = await db
            .select({ title: decks.title })
            .from(decks)
            .where(eq(decks.id, id))
            .limit(1)
          const inviter = await getUserBySub(db, inviterSub)
          if (!deckRow || !inviter) return
          const spaOrigin =
            process.env['SPA_ORIGIN'] ??
            process.env['PUBLIC_URL'] ??
            `https://${process.env['DOMAIN'] ?? 'localhost'}`
          const returnTo = encodeURIComponent(`/deck/${id}`)
          const signInUrl = `${spaOrigin}/api/auth/start?returnTo=${returnTo}`
          const { subject, html, text } = renderDeckInviteEmail({
            recipientEmail: email.toLowerCase(),
            deckTitle: deckRow.title,
            inviterName: inviter.name ?? inviter.email,
            inviterEmail: inviter.email,
            role,
            signInUrl,
          })
          await sendEmail({ to: email.toLowerCase(), subject, html, text })
        } catch (err) {
          request.log.warn({ err, deckId: id, email }, '[invite] email send failed')
        }
      })()

      return reply.status(201).send({
        kind: 'pending',
        invite: {
          id: invite.id,
          email: email.toLowerCase(),
          role,
          expiresAt: invite.expiresAt,
          replaced: invite.replaced,
        },
      })
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
  // GET /decks/:id/invites — pending email invites
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/decks/:id/invites',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id } = request.params
      const pending = await listPendingInvitesForDeck(db, id)
      return reply.send(
        pending.map((p) => ({
          id: p.id,
          email: p.email,
          role: p.role,
          invitedAt: p.invitedAt,
          expiresAt: p.expiresAt,
        })),
      )
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /decks/:id/invites/:inviteId — cancel pending invite
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/decks/:id/invites/:inviteId',
    { preHandler: ownerGuard },
    async (request, reply) => {
      const { id, inviteId } = request.params
      await revokeInvite(db, { deckId: id, inviteId })
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
