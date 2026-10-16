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
import {
  grantPermission,
  listPermissions,
  resolveFolderContentAccess,
  revokePermission,
  type PermissionRow,
} from '../auth/permissions.js'
import { createShareLink, listShareLinks, revokeShareLink } from '../auth/shareLinks.js'
import { closeDeckConnections, closeUserConnectionsOnDocument } from '../hocuspocus/connections.js'
import { endRenderSessions } from '../render/sessions.js'
import { createInvite, listPendingInvitesForDeck, revokeInvite } from '../auth/invites.js'
import { getUserByEmail, getUserBySub, listUsersBySubs } from '../auth/users.js'
import { notify } from '../email/notify.js'
import { deckRoleBefore, notifyAccessRemoved } from '../email/events.js'
import { signImgproxyUrl } from '../media/imgproxyUrl.js'
import type { EmailAccess } from '../email/templates/deckInvite.js'
import { renderDeckInviteEmail } from '../email/templates/deckInvite.js'
import type { ServiceDeps } from './deps.js'
import { badRequest, conflict, notFound } from './errors.js'
import { iso, isoOrNull } from './shared.js'

export const SELF_ROLE_CHANGE =
  'You cannot change your own role. Ask another owner to change it for you.'

// RFC-5322-lite — good enough for an invite. Real validation happens when
// the invitee signs in with Google.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** 400 unless `email` looks like an address an invitation can go to. */
export function requireInviteEmail(email: string): void {
  if (!EMAIL_PATTERN.test(email) || email.length > 320) throw badRequest('invalid email')
}

/**
 * The link an invitation email carries: Google sign-in that lands on
 * `returnTo` (a path of the web app) afterwards.
 */
export function inviteSignInUrl(returnTo: string): string {
  return `${appOrigin()}/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`
}

/** The web app's public origin, as the emails link to it. */
export function appOrigin(): string {
  return (
    process.env['SPA_ORIGIN'] ??
    process.env['PUBLIC_URL'] ??
    `https://${process.env['DOMAIN'] ?? 'localhost'}`
  )
}

/**
 * A deck thumbnail a mail client can fetch: the signed imgproxy URL of its
 * `preview` variant (the URL is the access, like the home page's), or null
 * without a thumbnail or without imgproxy signing configured.
 */
export function emailThumbnailUrl(thumbnailKey: string | null | undefined): string | null {
  if (!thumbnailKey || !process.env['IMGPROXY_KEY']) return null
  return signImgproxyUrl({ storageKey: thumbnailKey, variant: 'preview', extension: 'jpg' })
}

/** Permission rows with the email and name of each user, in one directory query. */
export async function withUserDetails(
  db: ServiceDeps['db'],
  rows: readonly PermissionRow[],
): Promise<PermissionEntry[]> {
  const usersList = await listUsersBySubs(
    db,
    rows.map((p) => p.userId),
  )
  const usersBySub = new Map(usersList.map((u) => [u.sub, u]))
  return rows.map((p) => {
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

  /**
   * Fire-and-forget email; the invite row or the permission exists either
   * way. `granted`: someone who already uses Narrative got access at once.
   */
  function sendInviteEmail(
    deckId: string,
    email: string,
    role: DeckRole,
    inviterSub: string,
    access: EmailAccess = 'invite',
  ) {
    void notify({
      db,
      log: deps.log,
      kind: 'deck-shared',
      to: email,
      render: async () => {
        const [deckRow] = await db
          .select({ title: decks.title, thumbnailKey: decks.thumbnailKey })
          .from(decks)
          .where(eq(decks.id, deckId))
          .limit(1)
        const inviter = await getUserBySub(db, inviterSub)
        if (!deckRow || !inviter) return null
        return {
          ...renderDeckInviteEmail({
            recipientEmail: email.toLowerCase(),
            deckTitle: deckRow.title,
            inviterName: inviter.name ?? inviter.email,
            inviterEmail: inviter.email,
            role,
            signInUrl: inviteSignInUrl(`/deck/${deckId}`),
            access,
            appOrigin: appOrigin(),
            previewUrl: emailThumbnailUrl(deckRow.thumbnailKey),
          }),
          // Replies reach the actual inviter, not a noreply mailbox.
          replyTo: inviter.email,
        }
      },
    })
  }

  async function listPermissionsWithUsers(args: { deckId: string }): Promise<PermissionEntry[]> {
    return withUserDetails(db, await listPermissions(db, args.deckId))
  }

  async function invite(args: {
    deckId: string
    inviterUserId: string
    email: string
    role: DeckRole
  }): Promise<InviteResult> {
    const { deckId, email, role, inviterUserId } = args
    requireInviteEmail(email)

    const existingUser = await getUserByEmail(db, email)
    if (existingUser) {
      // Only another owner can change your role: picking a lower role for
      // yourself would lock you out of the dialog you are standing in.
      if (existingUser.sub === inviterUserId) throw conflict(SELF_ROLE_CHANGE)
      const previous = (await listPermissions(db, deckId)).find(
        (p) => p.userId === existingUser.sub,
      )
      const granted = await grant(deckId, existingUser, role, inviterUserId)
      // They get access at once, and an email saying so: on a new grant or
      // a new role, never for the same role again.
      if (previous?.role !== role)
        sendInviteEmail(deckId, existingUser.email, role, inviterUserId, 'granted')
      return { kind: 'granted', user: granted }
    }

    // Re-inviting the same email replaces the pending invite's role.
    const created = await createInvite(db, { deckId, email, role, invitedBySub: inviterUserId })
    // Inviting the same address again re-sends only on a new role, or after a day.
    if (created.emailDue) sendInviteEmail(deckId, email, role, inviterUserId)
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
    const was = await deckRoleBefore(deps, deckId, userId)
    await revokePermission(db, { deckId, userId })
    if (was !== null)
      notifyAccessRemoved(deps, {
        actorId: callerUserId,
        memberId: userId,
        kind: 'deck',
        role: was,
        title: async () =>
          (
            await db.select({ title: decks.title }).from(decks).where(eq(decks.id, deckId)).limit(1)
          )[0]?.title ?? null,
      })
    // CONN-1: kick the revoked user's live connections on this deck, and on
    // its folder's token document when this deck was what let them read it —
    // and their render sessions' pages (render/sessions.ts).
    closeDeckConnections(deckId, { userId })
    endRenderSessions({ userId, deckId })
    const [deck] = await db
      .select({ folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, deckId))
      .limit(1)
    if (
      deck?.folderId &&
      !(await resolveFolderContentAccess(db, { folderId: deck.folderId, userId }))
    ) {
      closeUserConnectionsOnDocument(`folder:${deck.folderId}`, userId)
    }
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
