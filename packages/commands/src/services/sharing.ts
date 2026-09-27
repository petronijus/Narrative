/**
 * `SharingService` — defined here, implemented by apps/server/src/services/sharing.ts.
 * See ../services.ts for the pattern: the /decks/:id/{permissions,invites,
 * share-links} routes and the `share.*` commands call these same methods.
 * Every method assumes the caller already holds the owner role on the deck.
 */

import type { DeckRole } from './common.js'

export interface PermissionEntry {
  userId: string
  role: DeckRole
  grantedAt: string
  grantedBy: string | null
  email: string | null
  name: string | null
}

export interface GrantedUser {
  userId: string
  email: string
  name: string | null
  role: DeckRole
}

export type InviteResult =
  | { kind: 'granted'; user: GrantedUser }
  | {
      kind: 'pending'
      invite: { id: string; email: string; role: DeckRole; expiresAt: string; replaced: boolean }
    }

export interface PendingInvite {
  id: string
  email: string
  role: DeckRole
  invitedAt: string
  expiresAt: string
}

export interface ShareLinkEntry {
  id: string
  role: DeckRole
  createdAt: string
  expiresAt: string | null
  createdBy: string
  revoked: boolean
}

export interface SharingService {
  listPermissions(args: { deckId: string }): Promise<PermissionEntry[]>
  /**
   * Share by email: a known user is granted the role at once (their open
   * editors reconnect with it); an unknown address gets a pending invite
   * and an invitation email.
   */
  invite(args: {
    deckId: string
    inviterUserId: string
    email: string
    role: DeckRole
  }): Promise<InviteResult>
  /** Change the role of an existing collaborator. */
  setRole(args: {
    deckId: string
    callerUserId: string
    userId: string
    role: DeckRole
  }): Promise<GrantedUser>
  /** Remove a collaborator (never yourself, never the last owner) and close their live connections. */
  revoke(args: { deckId: string; callerUserId: string; userId: string }): Promise<void>
  listInvites(args: { deckId: string }): Promise<PendingInvite[]>
  cancelInvite(args: { deckId: string; inviteId: string }): Promise<void>
  /** Active (not revoked) share links. */
  listLinks(args: { deckId: string }): Promise<ShareLinkEntry[]>
  createLink(args: {
    deckId: string
    userId: string
    role: DeckRole
    expiresAt?: string | null | undefined
  }): Promise<{ id: string; url: string }>
  /** Revoke a link and close the connections opened with it. */
  revokeLink(args: { deckId: string; linkId: string }): Promise<void>
}
