/**
 * auth/permissions.ts
 *
 * Permission helpers for deck access control.
 *
 * These functions are the authoritative source of truth for:
 *   - Granting / revoking explicit per-user roles on a deck
 *   - Listing who has access to a deck
 *   - Resolving a user's effective role (direct grant → owner fallback → share link)
 *   - Checking whether a user meets a minimum required role
 *
 * Consumed by (phase 2):
 *   - Fastify route middleware (pre-handler hooks)
 *   - Hocuspocus onAuthenticate (pass userId + optional shareToken from WS query params)
 *
 * See also: auth/shareLinks.ts for share-link CRUD.
 */

import { and, eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { deckPermissions, decks, folders } from '../db/schema.js'
import { findShareLink } from './shareLinks.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeckRole = 'owner' | 'editor' | 'viewer'

export interface DeckAccessResult {
  role: DeckRole
  /** How access was determined. Useful for audit logging / UI hints. */
  reason: 'direct' | 'share-link' | 'owner-fallback'
}

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

const roleLevel: Record<DeckRole, number> = { viewer: 1, editor: 2, owner: 3 }

/**
 * Returns true if `actual` role satisfies the `required` minimum.
 * Example: roleAtLeast('editor', 'viewer') → true
 *          roleAtLeast('viewer', 'editor') → false
 */
export function roleAtLeast(actual: DeckRole, required: DeckRole): boolean {
  return roleLevel[actual] >= roleLevel[required]
}

// ---------------------------------------------------------------------------
// Mutation helpers
// ---------------------------------------------------------------------------

/**
 * Grants a role to a user on a deck. Uses upsert semantics — if the user
 * already has a role, it is overwritten with the new role.
 */
export async function grantPermission(
  db: Database,
  args: { deckId: string; userId: string; role: DeckRole; grantedBy: string },
): Promise<void> {
  await db
    .insert(deckPermissions)
    .values({
      deckId: args.deckId,
      userId: args.userId,
      role: args.role,
      grantedBy: args.grantedBy,
    })
    .onConflictDoUpdate({
      target: [deckPermissions.deckId, deckPermissions.userId],
      set: {
        role: args.role,
        grantedBy: args.grantedBy,
        grantedAt: new Date(),
      },
    })
}

/**
 * Revokes a user's permission on a deck. No-op if the user had no permission.
 */
export async function revokePermission(
  db: Database,
  args: { deckId: string; userId: string },
): Promise<void> {
  await db
    .delete(deckPermissions)
    .where(and(eq(deckPermissions.deckId, args.deckId), eq(deckPermissions.userId, args.userId)))
}

export interface PermissionRow {
  userId: string
  role: DeckRole
  grantedAt: Date
  grantedBy: string | null
}

/**
 * Lists all explicit permission grants for a deck.
 */
export async function listPermissions(db: Database, deckId: string): Promise<PermissionRow[]> {
  const rows = await db.select().from(deckPermissions).where(eq(deckPermissions.deckId, deckId))

  return rows.map((r) => ({
    userId: r.userId,
    role: r.role as DeckRole,
    grantedAt: r.grantedAt,
    grantedBy: r.grantedBy,
  }))
}

// ---------------------------------------------------------------------------
// Access resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the effective role a principal has on a deck.
 *
 * Resolution order:
 *   1. If userId is provided, look up deck_permissions. Return the explicit role if found.
 *   2. If userId matches decks.owner_user_id, return 'owner' (owner-fallback for
 *      decks created before M10 that don't have a deck_permissions row yet).
 *   3. If shareToken is provided, delegate to findShareLink. Return the link's role.
 *   4. Return null — no access.
 *
 * @param args.userId     Authentik 'sub' claim, or null for unauthenticated access via share link.
 * @param args.shareToken Optional share link token from query string.
 */
export async function resolveDeckAccess(
  db: Database,
  args: { deckId: string; userId: string | null; shareToken?: string | null },
): Promise<DeckAccessResult | null> {
  const { deckId, userId, shareToken } = args

  // 1. Explicit deck_permissions row
  if (userId) {
    const [row] = await db
      .select()
      .from(deckPermissions)
      .where(and(eq(deckPermissions.deckId, deckId), eq(deckPermissions.userId, userId)))
      .limit(1)

    if (row) {
      return { role: row.role as DeckRole, reason: 'direct' }
    }

    // 2. Owner fallback — covers decks created before M10 that lack a permissions row
    const [deck] = await db
      .select({ ownerUserId: decks.ownerUserId })
      .from(decks)
      .where(eq(decks.id, deckId))
      .limit(1)

    if (!deck) {
      // Deck doesn't exist
      return null
    }

    if (deck.ownerUserId === userId) {
      return { role: 'owner', reason: 'owner-fallback' }
    }
  }

  // 3. Share link
  if (shareToken) {
    const link = await findShareLink(db, shareToken)
    if (link && link.deckId === deckId) {
      return { role: link.role, reason: 'share-link' }
    }
  }

  return null
}

/**
 * Returns true if the principal has at least the required role on the deck.
 *
 * Convenience wrapper around resolveDeckAccess + roleAtLeast.
 */
export async function checkDeckPermission(
  db: Database,
  args: {
    deckId: string
    userId: string | null
    required: DeckRole
    shareToken?: string | null
  },
): Promise<boolean> {
  const access = await resolveDeckAccess(db, {
    deckId: args.deckId,
    userId: args.userId,
    // Normalise undefined → null to satisfy exactOptionalPropertyTypes
    shareToken: args.shareToken ?? null,
  })

  if (!access) return false
  return roleAtLeast(access.role, args.required)
}

// ---------------------------------------------------------------------------
// Folder access — M16 P2
// ---------------------------------------------------------------------------

export interface FolderAccessResult {
  role: 'owner'
  reason: 'direct'
}

/**
 * Resolves whether a userId may access a folder's Hocuspocus Y.Doc.
 *
 * Folders have a single owner; no per-folder ACL table exists yet.
 * Rule: only the folder's `owner_user_id` may connect.
 *
 * Returns { role: 'owner', reason: 'direct' } on success, or null on deny.
 * `userId` must be non-null — share-link access to folder docs is not supported.
 */
export async function resolveFolderAccess(
  db: Database,
  args: { folderId: string; userId: string | null },
): Promise<FolderAccessResult | null> {
  if (!args.userId) return null

  const [row] = await db
    .select({ ownerUserId: folders.ownerUserId })
    .from(folders)
    .where(eq(folders.id, args.folderId))
    .limit(1)

  if (!row) return null
  if (row.ownerUserId !== args.userId) return null

  return { role: 'owner', reason: 'direct' }
}
