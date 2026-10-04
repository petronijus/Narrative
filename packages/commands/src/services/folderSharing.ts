/**
 * `FolderSharingService` — defined here, implemented by
 * apps/server/src/services/folderSharing.ts. See ../services.ts for the
 * pattern: the /folders/:id/{members,invites} routes and the
 * `folder.members.*` / `folder.invites.*` commands call these same methods.
 *
 * A folder member sees everything in the folder — its decks, components,
 * pictures, videos, fonts and tokens — with their folder role
 * (docs/plans/folder-sharing.md). Every method authorises the caller itself:
 * only the folder's owners may list, invite, change or remove members, and
 * the Drafts folder cannot be shared.
 */

import type { DeckRole } from './common.js'
import type { GrantedUser, InviteResult, PendingInvite, PermissionEntry } from './sharing.js'

export interface FolderSharingService {
  /** The folder's members, each with their role, email and name. */
  listMembers(args: { userId: string; folderId: string }): Promise<PermissionEntry[]>
  /**
   * Share the folder by email: a known user becomes a member at once (their
   * open editors in the folder reconnect with the role); an unknown address
   * gets a pending invite and an invitation email. Inviting a member changes
   * their role.
   */
  invite(args: {
    userId: string
    folderId: string
    email: string
    role: DeckRole
  }): Promise<InviteResult>
  /** Change the role of an existing member — never your own. */
  setRole(args: {
    userId: string
    folderId: string
    memberId: string
    role: DeckRole
  }): Promise<GrantedUser>
  /**
   * Remove a member (never yourself, never the last owner) and close their
   * live connections on the folder, its components and its decks.
   */
  removeMember(args: { userId: string; folderId: string; memberId: string }): Promise<void>
  listInvites(args: { userId: string; folderId: string }): Promise<PendingInvite[]>
  /** Withdraw a pending invite (404 when there is no such pending invite). */
  cancelInvite(args: { userId: string; folderId: string; inviteId: string }): Promise<void>
}
