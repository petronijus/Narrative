/**
 * services/folderSharing.ts — server implementation of `FolderSharingService`
 * (packages/commands/src/services/folderSharing.ts): folder sharing, step 3
 * (docs/plans/folder-sharing.md). The /folders/:id/{members,invites} routes
 * and the `folder.members.*` / `folder.invites.*` commands call these
 * functions.
 *
 * A member sees everything in the folder with their folder role — its decks,
 * components, pictures, videos, fonts and tokens. Every function needs the
 * owner role in the folder (`requireFolderRole`); the Drafts folder cannot be
 * shared. The rules mirror deck sharing (services/sharing.ts): an invite to a
 * known address grants the role at once, an unknown one gets a pending
 * invite and an email; nobody changes or removes their own membership, and
 * the last owner stays.
 *
 * A membership changes in one transaction that locks the folder row
 * (`SELECT … FOR UPDATE`) and re-checks the caller's role and the
 * last-owner rule inside it, so two owners acting at once cannot leave the
 * folder without one. Removing a member also takes away the deck grants they
 * gave themselves there — the creator's owner row of each deck they made
 * (granted by themselves or by a migration), which would otherwise keep
 * them owner of those decks — and cancels the invites they sent; a grant
 * someone else gave them stays. An owner demoted to editor or viewer loses
 * their pending invites too. (Security review H1, L1, L2; Petr 2026-10-04.)
 *
 * Every change of someone's membership closes their live connections on the
 * folder's documents, components and decks (CONN-1): an open socket keeps the
 * role it authenticated with, so they reconnect and get the new one.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type {
  DeckRole,
  FolderSharingService,
  GrantedUser,
  InviteResult,
  PendingInvite,
  PermissionEntry,
} from '@narrative/commands'
import type { Database } from '../db/client.js'
import {
  components,
  deckPermissions,
  decks,
  folderInvites,
  folderPermissions,
  folders,
} from '../db/schema.js'
import { listFolderPermissions, roleAtLeast } from '../auth/permissions.js'
import {
  createFolderInvite,
  listPendingInvitesForFolder,
  revokeFolderInvite,
} from '../auth/invites.js'
import { getUserByEmail, getUserBySub } from '../auth/users.js'
import { closeUserFolderConnections } from '../hocuspocus/connections.js'
import { endRenderSessions } from '../render/sessions.js'
import { sendEmail } from '../email/client.js'
import { renderFolderInviteEmail } from '../email/templates/deckInvite.js'
import type { ServiceDeps } from './deps.js'
import { conflict, forbidden, notFound } from './errors.js'
import { bypassAliases, folderRoleRefusal, iso, requireFolderRole } from './shared.js'
import {
  SELF_ROLE_CHANGE,
  inviteSignInUrl,
  requireInviteEmail,
  withUserDetails,
} from './sharing.js'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

/**
 * What a membership change does: give `role` (an invite grants it to anyone;
 * a role change needs an existing member), or remove the member.
 */
type MembershipChange = { kind: 'set'; role: DeckRole; membersOnly: boolean } | { kind: 'remove' }

const roleRank: Record<DeckRole, number> = { viewer: 1, editor: 2, owner: 3 }

export function createFolderSharingService(deps: ServiceDeps): FolderSharingService {
  const { db } = deps

  /** The folder, which the caller must own. */
  function requireOwner(folderId: string, userId: string) {
    return requireFolderRole(db, folderId, userId, 'owner', { bypass: deps.bypass })
  }

  /** Whether `memberId` is the caller (BYPASS_AUTH counts the legacy demo user as the caller too). */
  function isCaller(userId: string, memberId: string): boolean {
    return memberId === userId || bypassAliases(userId, deps.bypass).includes(memberId)
  }

  /**
   * Close the member's live connections on everything the folder opens to
   * them, so they reconnect with whatever access they now have.
   */
  async function disconnect(folderId: string, memberId: string): Promise<void> {
    const [deckRows, componentRows] = await Promise.all([
      db.select({ id: decks.id }).from(decks).where(eq(decks.folderId, folderId)),
      db.select({ id: components.id }).from(components).where(eq(components.folderId, folderId)),
    ])
    closeUserFolderConnections(memberId, {
      folderId,
      deckIds: deckRows.map((d) => d.id),
      componentIds: componentRows.map((c) => c.id),
    })
    // Pages kept for their render sessions read those decks too.
    for (const d of deckRows) endRenderSessions({ userId: memberId, deckId: d.id })
  }

  /**
   * Give `memberId` a role in the folder, or remove them, as `userId` — in one
   * transaction holding the folder row's lock: the caller must (still) be an
   * owner, nobody changes their own membership, and the folder keeps an
   * owner. Returns the member's role before the change (null: not a member).
   */
  async function changeMembership(
    folderId: string,
    userId: string,
    memberId: string,
    change: MembershipChange,
  ): Promise<DeckRole | null> {
    if (isCaller(userId, memberId)) {
      throw conflict(
        change.kind === 'remove'
          ? 'You cannot remove yourself from a folder. Ask another owner to remove you.'
          : SELF_ROLE_CHANGE,
      )
    }
    const before = await db.transaction(async (tx) => {
      const [folder] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.id, folderId))
        .for('update')
      if (!folder) throw notFound('Folder not found')
      const members = await tx
        .select({ userId: folderPermissions.userId, role: folderPermissions.role })
        .from(folderPermissions)
        .where(eq(folderPermissions.folderId, folderId))
      requireOwnerAmong(members, userId)

      const current = (members.find((m) => m.userId === memberId)?.role ?? null) as DeckRole | null
      if (current === null && (change.kind === 'remove' || change.membersOnly)) {
        throw memberNotFound()
      }
      const losesOwner =
        current === 'owner' && (change.kind === 'remove' || change.role !== 'owner')
      if (losesOwner && !members.some((m) => m.role === 'owner' && m.userId !== memberId)) {
        throw conflict('A folder keeps at least one owner — make someone else an owner first.')
      }

      if (change.kind === 'remove') {
        await tx
          .delete(folderPermissions)
          .where(
            and(eq(folderPermissions.folderId, folderId), eq(folderPermissions.userId, memberId)),
          )
        await dropOwnDeckGrants(tx, folderId, memberId)
      } else if (current === null) {
        await tx
          .insert(folderPermissions)
          .values({ folderId, userId: memberId, role: change.role, grantedBy: userId })
      } else {
        // A role change keeps who granted the membership (what "Shared by" shows).
        await tx
          .update(folderPermissions)
          .set({ role: change.role, grantedAt: new Date() })
          .where(
            and(eq(folderPermissions.folderId, folderId), eq(folderPermissions.userId, memberId)),
          )
      }
      if (losesOwner) await cancelInvitesBy(tx, folderId, memberId)
      return current
    })
    await disconnect(folderId, memberId)
    return before
  }

  /** 403 unless `userId` (or their BYPASS_AUTH alias) owns the folder, from its locked member rows. */
  function requireOwnerAmong(members: Array<{ userId: string; role: string }>, userId: string) {
    const ids = [userId, ...bypassAliases(userId, deps.bypass)]
    let best: DeckRole | null = null
    for (const m of members) {
      const role = m.role as DeckRole
      if (ids.includes(m.userId) && (best === null || roleRank[role] > roleRank[best])) best = role
    }
    if (best === null) throw forbidden()
    if (!roleAtLeast(best, 'owner')) throw forbidden(folderRoleRefusal('owner'))
  }

  /**
   * The deck grants `memberId` gave themselves on the folder's decks — the
   * creator's owner row of each deck they made there (granted by themselves,
   * or by migration 0031 with no granter). Membership was their way in;
   * without it they keep only what someone else granted them.
   */
  async function dropOwnDeckGrants(tx: Tx, folderId: string, memberId: string) {
    const folderDecks = tx.select({ id: decks.id }).from(decks).where(eq(decks.folderId, folderId))
    await tx
      .delete(deckPermissions)
      .where(
        and(
          eq(deckPermissions.userId, memberId),
          inArray(deckPermissions.deckId, folderDecks),
          or(isNull(deckPermissions.grantedBy), eq(deckPermissions.grantedBy, memberId)),
        ),
      )
  }

  /** Withdraw the pending invites `memberId` sent to the folder (they are no longer an owner). */
  async function cancelInvitesBy(tx: Tx, folderId: string, memberId: string) {
    await tx
      .delete(folderInvites)
      .where(
        and(
          eq(folderInvites.folderId, folderId),
          eq(folderInvites.invitedBySub, memberId),
          isNull(folderInvites.acceptedAt),
        ),
      )
  }

  const memberNotFound = () =>
    notFound('That user is not a member of this folder; invite them with their email instead.')

  /** Fire-and-forget invitation email; the invite row exists either way. */
  function sendInviteEmail(folderId: string, email: string, role: DeckRole, inviterSub: string) {
    void (async () => {
      try {
        const [folderRow] = await db
          .select({ name: folders.name })
          .from(folders)
          .where(eq(folders.id, folderId))
          .limit(1)
        const inviter = await getUserBySub(db, inviterSub)
        if (!folderRow || !inviter) return
        const { subject, html, text } = renderFolderInviteEmail({
          recipientEmail: email.toLowerCase(),
          folderName: folderRow.name,
          inviterName: inviter.name ?? inviter.email,
          inviterEmail: inviter.email,
          role,
          signInUrl: inviteSignInUrl(`/folder/${folderId}`),
        })
        await sendEmail({ to: email.toLowerCase(), subject, html, text, replyTo: inviter.email })
      } catch (err) {
        deps.log.warn({ err, folderId, email }, '[invite] folder invitation email failed')
      }
    })()
  }

  async function listMembers(args: {
    userId: string
    folderId: string
  }): Promise<PermissionEntry[]> {
    await requireOwner(args.folderId, args.userId)
    return withUserDetails(db, await listFolderPermissions(db, args.folderId))
  }

  async function invite(args: {
    userId: string
    folderId: string
    email: string
    role: DeckRole
  }): Promise<InviteResult> {
    const { folderId, email, role, userId } = args
    requireInviteEmail(email)
    const folder = await requireOwner(folderId, userId)
    if (folder.isDrafts) {
      throw conflict(
        'The Drafts folder is private and cannot be shared. Move the decks to share into another folder.',
      )
    }

    const existingUser = await getUserByEmail(db, email)
    if (existingUser) {
      await changeMembership(folderId, userId, existingUser.sub, {
        kind: 'set',
        role,
        membersOnly: false,
      })
      return {
        kind: 'granted',
        user: {
          userId: existingUser.sub,
          email: existingUser.email,
          name: existingUser.name,
          role,
        },
      }
    }

    // Inviting the same address again updates the pending invite; it is
    // emailed again only for a new role, or after a day.
    const created = await createFolderInvite(db, { folderId, email, role, invitedBySub: userId })
    if (created.emailDue) sendInviteEmail(folderId, email, role, userId)
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
    userId: string
    folderId: string
    memberId: string
    role: DeckRole
  }): Promise<GrantedUser> {
    const { folderId, userId, memberId, role } = args
    await requireOwner(folderId, userId)
    await changeMembership(folderId, userId, memberId, { kind: 'set', role, membersOnly: true })
    const user = await getUserBySub(db, memberId)
    return { userId: memberId, email: user?.email ?? '', name: user?.name ?? null, role }
  }

  async function removeMember(args: {
    userId: string
    folderId: string
    memberId: string
  }): Promise<void> {
    await requireOwner(args.folderId, args.userId)
    await changeMembership(args.folderId, args.userId, args.memberId, { kind: 'remove' })
  }

  async function listInvites(args: { userId: string; folderId: string }): Promise<PendingInvite[]> {
    await requireOwner(args.folderId, args.userId)
    const pending = await listPendingInvitesForFolder(db, args.folderId)
    return pending.map((p) => ({
      id: p.id,
      email: p.email,
      role: p.role as DeckRole,
      invitedAt: iso(p.invitedAt),
      expiresAt: iso(p.expiresAt),
    }))
  }

  async function cancelInvite(args: {
    userId: string
    folderId: string
    inviteId: string
  }): Promise<void> {
    await requireOwner(args.folderId, args.userId)
    const removed = await revokeFolderInvite(db, {
      folderId: args.folderId,
      inviteId: args.inviteId,
    })
    if (!removed) throw notFound('Invite not found (it may have been accepted or cancelled)')
  }

  return { listMembers, invite, setRole, removeMember, listInvites, cancelInvite }
}
