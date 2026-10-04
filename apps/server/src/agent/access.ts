/**
 * agent/access.ts
 *
 * Authorisation for agent invocations, per command scope (ADR 0011: "every
 * ServerHost entry point owns an access check" — a Hocuspocus direct
 * connection skips `onAuthenticate`, so nothing downstream checks again).
 *
 * The rules are the ones the WebSocket and the HTTP routes already apply,
 * called through the same resolvers in auth/permissions.ts, with one
 * deliberate difference: share links never apply. An agent always acts as
 * a signed-in user with that user's own role; a share link is a capability
 * for an anonymous browser, not something a token or MCP session carries.
 */

import type { Role } from '@narrative/commands'
import type { Database } from '../db/client.js'
import {
  resolveComponentAccess,
  resolveDeckAccess,
  resolveFolderAccess,
} from '../auth/permissions.js'

export interface AgentAccess {
  /** The user's role on the deck, or null (no access, or no such deck). */
  deckRole(deckId: string, userId: string): Promise<Role | null>
  /** The user's role on a component master (their role in its folder), or null. */
  componentRole(componentId: string, userId: string): Promise<Role | null>
  /**
   * The user's role in a folder — a MEMBER's (folder_permissions), or null.
   * Deliberately not "content reader": a guest of one of the folder's decks
   * reads its tokens and fonts through that deck, never as a folder-scoped
   * agent command (agent/access.integration.test.ts).
   */
  folderRole(folderId: string, userId: string): Promise<Role | null>
}

export function createDbAccess(db: Database): AgentAccess {
  return {
    async deckRole(deckId, userId) {
      const access = await resolveDeckAccess(db, { deckId, userId, shareToken: null })
      return access?.role ?? null
    },
    async componentRole(componentId, userId) {
      const access = await resolveComponentAccess(db, { componentId, userId })
      return access?.role ?? null
    },
    async folderRole(folderId, userId) {
      const access = await resolveFolderAccess(db, { folderId, userId })
      return access?.role ?? null
    },
  }
}
