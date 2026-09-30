/**
 * auth/permissions.ts
 *
 * Permission helpers for deck access control.
 *
 * These functions are the authoritative source of truth for:
 *   - Granting / revoking explicit per-user roles on a deck
 *   - Listing who has access to a deck
 *   - Resolving a user's effective role on a deck: the highest of its own
 *     grant, the role in the deck's folder (folder sharing — a folder member
 *     has that role on every deck in it), the owner fallback, a share link
 *   - Resolving a user's role in a folder and on its components, and whether
 *     they may read the folder's shared content (tokens, fonts, component
 *     media) through one of its decks
 *   - Checking whether a user meets a minimum required role
 *
 * Folder sharing: docs/plans/folder-sharing.md.
 *
 * Consumed by (phase 2):
 *   - Fastify route middleware (pre-handler hooks)
 *   - Hocuspocus onAuthenticate (pass userId + optional shareToken from WS query params)
 *
 * See also: auth/shareLinks.ts for share-link CRUD.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { components, deckPermissions, decks, folderPermissions } from '../db/schema.js'
import { findShareLink } from './shareLinks.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeckRole = 'owner' | 'editor' | 'viewer'

export interface DeckAccessResult {
  role: DeckRole
  /** How access was determined. Useful for audit logging / UI hints. */
  reason: 'direct' | 'folder' | 'share-link'
}

/** The higher of two resolved roles, keeping its reason (null counts as no access; a tie keeps `a`). */
function higher<T extends { role: DeckRole }>(a: T | null, b: T | null): T | null {
  if (a === null || b === null) return a ?? b
  return roleLevel[b.role] > roleLevel[a.role] ? b : a
}

/** The higher of two roles (null counts as no access). */
export function higherRole(a: DeckRole | null, b: DeckRole | null): DeckRole | null {
  return higher(a === null ? null : { role: a }, b === null ? null : { role: b })?.role ?? null
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
 * Resolves the effective role a principal has on a deck: the highest of
 * (null when none applies, or the deck does not exist)
 *   1. the user's own deck_permissions row (a deck's creator has one —
 *      migration 0031 wrote it for decks older than the rule);
 *   2. the user's role in the deck's folder (folder sharing);
 *   3. the role of a share link to this deck.
 * `decks.owner_user_id` grants nothing: it records who created the deck.
 * The deck row and both grants come in one query.
 *
 * @param args.userId     the signed-in user, or null for an anonymous share-link visit.
 * @param args.shareToken Optional share link token from query string.
 */
export async function resolveDeckAccess(
  db: Database,
  args: { deckId: string; userId: string | null; shareToken?: string | null },
): Promise<DeckAccessResult | null> {
  const { deckId, userId, shareToken } = args
  let best: DeckAccessResult | null = null

  if (userId) {
    const [row] = await db
      .select({ deckRole: deckPermissions.role, folderRole: folderPermissions.role })
      .from(decks)
      .leftJoin(
        deckPermissions,
        and(eq(deckPermissions.deckId, decks.id), eq(deckPermissions.userId, userId)),
      )
      .leftJoin(
        folderPermissions,
        and(eq(folderPermissions.folderId, decks.folderId), eq(folderPermissions.userId, userId)),
      )
      .where(eq(decks.id, deckId))
      .limit(1)
    // Deck doesn't exist
    if (!row) return null
    if (row.deckRole) best = { role: row.deckRole as DeckRole, reason: 'direct' }
    if (row.folderRole) best = higher(best, { role: row.folderRole as DeckRole, reason: 'folder' })
  }

  if (shareToken) {
    const link = await findShareLink(db, shareToken)
    if (link && link.deckId === deckId)
      best = higher(best, { role: link.role, reason: 'share-link' })
  }

  return best
}

// ---------------------------------------------------------------------------
// Component access — M16 P5
// ---------------------------------------------------------------------------

export interface ComponentAccessResult {
  role: DeckRole
  reason: 'folder'
}

/**
 * The user's role on a component: their role in the component's folder
 * (viewer reads the master, editor changes it). A deck-only guest has none.
 * Returns null on deny; `userId` must be non-null — a share link never
 * reaches a component.
 */
export async function resolveComponentAccess(
  db: Database,
  args: { componentId: string; userId: string | null },
): Promise<ComponentAccessResult | null> {
  if (!args.userId) return null

  const [row] = await db
    .select({ folderId: components.folderId })
    .from(components)
    .where(eq(components.id, args.componentId))
    .limit(1)

  if (!row) return null

  const folderAccess = await resolveFolderAccess(db, {
    folderId: row.folderId,
    userId: args.userId,
  })
  return folderAccess === null ? null : { role: folderAccess.role, reason: 'folder' }
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
  role: DeckRole
  reason: 'direct'
}

/**
 * The user's role in a folder — their `folder_permissions` row (folder
 * sharing; the creator is the first owner, migration 0030). A member sees
 * everything in the folder with that role. `alsoAs` lists further user ids
 * that count as the same person (BYPASS_AUTH's demo user, services/shared.ts
 * `ownerIdsFor`); the highest role wins.
 *
 * Returns null on deny. `userId` must be non-null — share links never reach
 * a folder.
 */
export async function resolveFolderAccess(
  db: Database,
  args: { folderId: string; userId: string | null; alsoAs?: readonly string[] | undefined },
): Promise<FolderAccessResult | null> {
  if (!args.userId) return null
  const ids = [args.userId, ...(args.alsoAs ?? [])]
  const rows = await db
    .select({ role: folderPermissions.role })
    .from(folderPermissions)
    .where(
      and(eq(folderPermissions.folderId, args.folderId), inArray(folderPermissions.userId, ids)),
    )
  let best: FolderAccessResult | null = null
  for (const r of rows) best = higher(best, { role: r.role as DeckRole, reason: 'direct' })
  return best
}

/** How someone may read a folder's shared content (tokens, fonts, component media). */
export interface FolderContentAccess {
  role: DeckRole
  /** `folder`: a member, with their folder role; `deck`: a guest of one of its decks, read-only. */
  via: 'folder' | 'deck'
}

/**
 * Whether the user may READ the content a folder shares with all its decks —
 * its tokens, its fonts, its components' pictures and videos — and with what
 * role: a folder member with their folder role; anyone with access to a deck
 * in the folder (a deck grant, or a share link to one of its decks) as a
 * viewer, so a shared deck renders with its folder's styles and shows its
 * stamped components. Writing that content needs a folder role.
 */
export async function resolveFolderContentAccess(
  db: Database,
  args: {
    folderId: string
    userId: string | null
    shareToken?: string | null | undefined
    alsoAs?: readonly string[] | undefined
  },
): Promise<FolderContentAccess | null> {
  const member = await resolveFolderAccess(db, args)
  if (member) return { role: member.role, via: 'folder' }
  if (args.userId) {
    const [guest] = await db
      .select({ deckId: deckPermissions.deckId })
      .from(deckPermissions)
      .innerJoin(decks, eq(decks.id, deckPermissions.deckId))
      .where(
        and(
          inArray(deckPermissions.userId, [args.userId, ...(args.alsoAs ?? [])]),
          eq(decks.folderId, args.folderId),
        ),
      )
      .limit(1)
    if (guest) return { role: 'viewer', via: 'deck' }
  }
  if (args.shareToken) {
    const link = await findShareLink(db, args.shareToken)
    if (link) {
      const [deck] = await db
        .select({ folderId: decks.folderId })
        .from(decks)
        .where(eq(decks.id, link.deckId))
        .limit(1)
      if (deck?.folderId === args.folderId) return { role: 'viewer', via: 'deck' }
    }
  }
  return null
}
