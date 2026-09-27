/**
 * services/sharing.ts — server implementation of `SharingService`
 * (packages/commands/src/services/sharing.ts). The /decks/:id/{permissions,
 * invites,share-links} routes and the `share.*` commands call these
 * functions. Every function assumes the caller holds the owner role on the
 * deck (the route's `requireDeckRole('owner')`, the command's `role: 'owner'`).
 */

import { and, eq } from 'drizzle-orm'
import type {
  DeckRole,
  GrantedUser,
  InviteResult,
  PendingInvite,
  PermissionEntry,
  ShareLinkEntry,
  SharingService,
} from '@narrative/commands'
import { decks, deckPermissions } from '../db/schema.js'
import { grantPermission, listPermissions, revokePermission } from '../auth/permissions.js'
import { createShareLink, listShareLinks, revokeShareLink } from '../auth/shareLinks.js'
import { closeDeckConnections } from '../hocuspocus/connections.js'
import { createInvite, listPendingInvitesForDeck, revokeInvite } from '../auth/invites.js'
import { getUserByEmail, getUserBySub, listUsersBySubs } from '../auth/users.js'
import { sendEmail } from '../email/client.js'
import { renderDeckInviteEmail } from '../email/templates/deckInvite.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, notFound } from './errors.js'
import { iso, isoOrNull } from './shared.js'

const SELF_ROLE_CHANGE = 'You cannot change your own role. Ask another owner to change it for you.'

// RFC-5322-lite — good enough for an invite. Real validation happens when
// the invitee signs in with Google.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function createSharingService(deps: ServiceDeps): SharingService {
  const { db } = deps

  /**
   * Grant `role` to a known user and close their live connections on the
   * deck: a role change (a downgrade in particular) does not re-run
   * onAuthenticate on an open socket, so they would keep their old access
   * until reconnecting (CONN-1). Closing on an upgrade costs a brief reconnect.
   */
  async function grant(
    deckId: string,
    user: { sub: string; email: string; name: string | null },
    role: DeckRole,
    grantedBy: string,
  ): Promise<GrantedUser> {
    await grantPermission(db, { deckId, userId: user.sub, role, grantedBy })
    closeDeckConnections(deckId, { userId: user.sub })
    return { userId: user.sub, email: user.email, name: user.name, role }
  }

  /** Fire-and-forget invitation email; the invite row exists either way. */
  function sendInviteEmail(deckId: string, email: string, role: DeckRole, inviterSub: string) {
    void (async () => {
      try {
        const [deckRow] = await db
          .select({ title: decks.title })
          .from(decks)
          .where(eq(decks.id, deckId))
          .limit(1)
        const inviter = await getUserBySub(db, inviterSub)
        if (!deckRow || !inviter) return
        const spaOrigin =
          process.env['SPA_ORIGIN'] ??
          process.env['PUBLIC_URL'] ??
          `https://${process.env['DOMAIN'] ?? 'localhost'}`
        const returnTo = encodeURIComponent(`/deck/${deckId}`)
        const signInUrl = `${spaOrigin}/api/auth/start?returnTo=${returnTo}`
        const { subject, html, text } = renderDeckInviteEmail({
          recipientEmail: email.toLowerCase(),
          deckTitle: deckRow.title,
          inviterName: inviter.name ?? inviter.email,
          inviterEmail: inviter.email,
          role,
          signInUrl,
        })
        await sendEmail({
          to: email.toLowerCase(),
          subject,
          html,
          text,
          // Replies reach the actual inviter, not a noreply mailbox.
          replyTo: inviter.email,
        })
      } catch (err) {
        deps.log.warn({ err, deckId, email }, '[invite] email send failed')
      }
    })()
  }

  async function listPermissionsWithUsers(args: { deckId: string }): Promise<PermissionEntry[]> {
    const permissions = await listPermissions(db, args.deckId)
    // One round-trip for display fields via an IN list.
    const usersList = await listUsersBySubs(
      db,
      permissions.map((p) => p.userId),
    )
    const usersBySub = new Map(usersList.map((u) => [u.sub, u]))
    return permissions.map((p) => {
      const u = usersBySub.get(p.userId)
      return {
        userId: p.userId,
        role: p.role,
        grantedAt: iso(p.grantedAt),
        grantedBy: p.grantedBy,
        email: u?.email ?? null,
        name: u?.name ?? null,
      }
    })
  }

  async function invite(args: {
    deckId: string
    inviterUserId: string
    email: string
    role: DeckRole
  }): Promise<InviteResult> {
    const { deckId, email, role, inviterUserId } = args
    if (!EMAIL_PATTERN.test(email) || email.length > 320) throw badRequest('invalid email')

    const existingUser = await getUserByEmail(db, email)
    if (existingUser) {
      // Only another owner can change your role: picking a lower role for
      // yourself would lock you out of the dialog you are standing in.
      if (existingUser.sub === inviterUserId) throw conflict(SELF_ROLE_CHANGE)
      return { kind: 'granted', user: await grant(deckId, existingUser, role, inviterUserId) }
    }

    // Re-inviting the same email replaces the pending invite's role.
    const created = await createInvite(db, { deckId, email, role, invitedBySub: inviterUserId })
    sendInviteEmail(deckId, email, role, inviterUserId)
    return {
      kind: 'pending',
      invite: {
        id: created.id,
        email: email.toLowerCase(),
        role,
        expiresAt: iso(created.expiresAt),
        replaced: created.replaced,
      },
    }
  }

  async function setRole(args: {
    deckId: string
    callerUserId: string
    userId: string
    role: DeckRole
  }): Promise<GrantedUser> {
    const { deckId, callerUserId, userId, role } = args
    if (userId === callerUserId) throw conflict(SELF_ROLE_CHANGE)
    const [current] = await db
      .select({ role: deckPermissions.role })
      .from(deckPermissions)
      .where(and(eq(deckPermissions.deckId, deckId), eq(deckPermissions.userId, userId)))
      .limit(1)
    if (!current) {
      throw notFound(
        'That user is not a collaborator on this deck; invite them with their email instead.',
      )
    }
    const user = await getUserBySub(db, userId)
    return grant(
      deckId,
      { sub: userId, email: user?.email ?? '', name: user?.name ?? null },
      role,
      callerUserId,
    )
  }

  async function revoke(args: {
    deckId: string
    callerUserId: string
    userId: string
  }): Promise<void> {
    const { deckId, callerUserId, userId } = args
    // Removing yourself while standing in a dialog that requires your role is a lockout.
    if (userId === callerUserId) {
      throw conflict('You cannot remove yourself from a deck. Ask another owner to remove you.')
    }
    const owners = await db
      .select({ userId: deckPermissions.userId })
      .from(deckPermissions)
      .where(and(eq(deckPermissions.deckId, deckId), eq(deckPermissions.role, 'owner')))
    if (owners.some((o) => o.userId === userId) && owners.length <= 1) {
      throw conflict('Cannot revoke the last owner — assign another owner first.')
    }
    await revokePermission(db, { deckId, userId })
    // CONN-1: kick the revoked user's live connections on this deck only.
    closeDeckConnections(deckId, { userId })
  }

  async function listInvites(args: { deckId: string }): Promise<PendingInvite[]> {
    const pending = await listPendingInvitesForDeck(db, args.deckId)
    return pending.map((p) => ({
      id: p.id,
      email: p.email,
      role: p.role as DeckRole,
      invitedAt: iso(p.invitedAt),
      expiresAt: iso(p.expiresAt),
    }))
  }

  async function cancelInvite(args: { deckId: string; inviteId: string }): Promise<void> {
    await revokeInvite(db, args)
  }

  async function listLinks(args: { deckId: string }): Promise<ShareLinkEntry[]> {
    const links = await listShareLinks(db, args.deckId)
    return links
      .filter((l) => !l.revoked)
      .map((l) => ({
        id: l.id,
        role: l.role,
        createdAt: iso(l.createdAt),
        expiresAt: isoOrNull(l.expiresAt),
        createdBy: l.createdBy,
        revoked: l.revoked,
      }))
  }

  async function createLink(args: {
    deckId: string
    userId: string
    role: DeckRole
    expiresAt?: string | null | undefined
  }): Promise<{ id: string; url: string }> {
    let expiresAt: Date | null = null
    if (args.expiresAt !== undefined && args.expiresAt !== null) {
      expiresAt = new Date(args.expiresAt)
      if (Number.isNaN(expiresAt.getTime())) throw badRequest('expiresAt must be a date-time')
    }
    const link = await createShareLink(db, {
      deckId: args.deckId,
      role: args.role,
      createdBy: args.userId,
      expiresAt,
    })
    const publicUrl = process.env['PUBLIC_URL'] ?? ''
    return { id: link.id, url: `${publicUrl}/deck/${args.deckId}?share_token=${link.id}` }
  }

  async function revokeLink(args: { deckId: string; linkId: string }): Promise<void> {
    await revokeShareLink(db, args.linkId, args.deckId)
  }

  return {
    listPermissions: listPermissionsWithUsers,
    invite,
    setRole,
    revoke,
    listInvites,
    cancelInvite,
    listLinks,
    createLink,
    revokeLink,
  }
}
