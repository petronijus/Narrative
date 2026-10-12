/**
 * services/shared.ts — small helpers every service uses.
 */

import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { MAX_LIST_PAGE_SIZE, type FontFaceInfo } from '@narrative/commands'
import type { Database } from '../db/client.js'
import { components, folders } from '../db/schema.js'
import {
  resolveFolderAccess,
  resolveFolderContentAccess,
  roleAtLeast,
  type DeckRole,
  type FolderContentAccess,
} from '../auth/permissions.js'
import { presignGetUrl } from '../media/s3Client.js'
import { DEV_USER_SUB } from '../auth/devIdentity.js'
import type { FontAssetRow } from '../media/assets.js'
import { badRequest, forbidden, notFound } from './errors.js'

/** A timestamp as the API returns it (JSON of a Date is its ISO string). */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/**
 * The user ids whose folders / decks a user sees: BYPASS_AUTH dev mode adds
 * the legacy demo user for `dev-user` (not for the other synthetic
 * identities of auth/devIdentity.ts, which are people of their own).
 */
export function ownerIdsFor(userId: string, bypass: boolean | undefined): string[] {
  return [userId, ...bypassAliases(userId, bypass)]
}

/** The other ids that count as the user (a resolver's `alsoAs`): the legacy demo user for BYPASS_AUTH's `dev-user`, else none. */
export function bypassAliases(userId: string | null, bypass: boolean | undefined): string[] {
  return bypass === true && userId === DEV_USER_SUB ? ['demo-user'] : []
}

/** A folder the caller may act on, and their role in it. */
export interface FolderInRole {
  id: string
  ownerUserId: string
  name: string
  /** The creator's private Drafts folder (never shared, never deleted). */
  isDrafts: boolean
  role: DeckRole
}

/**
 * The folder, which must exist (else 404 "Folder not found") and in which
 * the user must hold at least `required` (else 403): viewer to read what is
 * in it, editor to change it, owner to rename, share or delete it
 * (docs/plans/folder-sharing.md). The role is the user's `folder_permissions`
 * row; BYPASS_AUTH counts the legacy demo user as the same person.
 */
export async function requireFolderRole(
  db: Database,
  folderId: string,
  userId: string,
  required: DeckRole,
  opts: { bypass?: boolean | undefined; notFoundMessage?: string } = {},
): Promise<FolderInRole> {
  const [folder] = await db
    .select({
      id: folders.id,
      ownerUserId: folders.ownerUserId,
      name: folders.name,
      isDrafts: folders.isDrafts,
    })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)
  if (!folder) throw notFound(opts.notFoundMessage ?? 'Folder not found')
  const access = await resolveFolderAccess(db, {
    folderId,
    userId,
    alsoAs: bypassAliases(userId, opts.bypass),
  })
  if (!access) throw forbidden()
  if (!roleAtLeast(access.role, required)) throw forbidden(folderRoleRefusal(required))
  return { ...folder, role: access.role }
}

/** Why a folder member with too low a role is refused. */
export function folderRoleRefusal(required: DeckRole): string {
  return required === 'owner'
    ? "Forbidden: only the folder's owner may do this"
    : 'Forbidden: this needs the editor role in the folder'
}

/** A component the caller may act on, and their role in its folder. */
export type ComponentInRole = typeof components.$inferSelect & { role: DeckRole }

/**
 * The component, in whose folder the user must hold at least `required`:
 * viewer reads a master, editor changes, deletes or uploads into it — the
 * rule of the `component:<id>` document (docs/plans/folder-sharing.md).
 *
 *   - no such component, or one of another folder than `opts.folderId`:
 *     404 "Component not found";
 *   - a user outside the folder: 403, or 404 as if it did not exist with
 *     `opts.unseen: 'not_found'` (where the caller only named an id and
 *     existence must not leak);
 *   - a member whose role is too low: 403 naming the role it needs.
 */
export async function requireComponentRole(
  db: Database,
  componentId: string,
  userId: string,
  required: DeckRole,
  opts: {
    bypass?: boolean | undefined
    folderId?: string | undefined
    unseen?: 'forbidden' | 'not_found'
  } = {},
): Promise<ComponentInRole> {
  const [row] = await db.select().from(components).where(eq(components.id, componentId)).limit(1)
  if (!row || (opts.folderId !== undefined && row.folderId !== opts.folderId)) {
    throw notFound('Component not found')
  }
  const access = await resolveFolderAccess(db, {
    folderId: row.folderId,
    userId,
    alsoAs: bypassAliases(userId, opts.bypass),
  })
  if (!access) throw opts.unseen === 'not_found' ? notFound('Component not found') : forbidden()
  if (!roleAtLeast(access.role, required)) throw forbidden(folderRoleRefusal(required))
  return { ...row, role: access.role }
}

/**
 * The folder, whose shared content — its tokens, fonts and components'
 * media — the user must be allowed to READ: a folder member, or anyone with
 * access to one of its decks (a deck guest reads it as a viewer, so a
 * shared deck renders with its folder's styles). 404 when the folder does
 * not exist, 403 otherwise.
 */
export async function requireFolderContentReader(
  db: Database,
  folderId: string,
  userId: string | null,
  opts: {
    bypass?: boolean | undefined
    /** A share link (or render token) to one of the folder's decks: read access as its guest. */
    shareToken?: string | null | undefined
  } = {},
): Promise<FolderContentAccess> {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)
  if (!folder) throw notFound('Folder not found')
  const access = await resolveFolderContentAccess(db, {
    folderId,
    userId,
    alsoAs: bypassAliases(userId, opts.bypass),
    shareToken: opts.shareToken ?? null,
  })
  if (!access) throw forbidden()
  return access
}

/** A font asset row as the font list endpoints return it (with a fresh presigned URL). */
export async function fontFaceInfo(row: FontAssetRow): Promise<FontFaceInfo> {
  return {
    assetId: row.id,
    family: row.fontFamily,
    weight: row.fontWeight,
    style: row.fontStyle,
    postscriptName: row.fontPostscriptName,
    ...(row.fontAxes !== null &&
    (row.fontAxes.wght !== undefined || row.fontAxes.wdth !== undefined)
      ? { axes: row.fontAxes }
      : {}),
    url: await presignGetUrl(row.storageKey),
    sizeBytes: row.sizeBytes,
    uploadedAt: iso(row.createdAt),
  }
}

// ---------------------------------------------------------------------------
// Paged lists (DeckService.listPage, FolderService.listPage)
// ---------------------------------------------------------------------------

/** A page size a paged list accepts (1 to MAX_LIST_PAGE_SIZE), else 400. */
export function validPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_PAGE_SIZE)
    throw badRequest(`limit must be an integer from 1 to ${MAX_LIST_PAGE_SIZE}`)
  return limit
}

/** `text` with LIKE's wildcards (`%`, `_`) and its escape character (`\`) escaped. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * "`column` contains `text`, ignoring case", with `text` matched literally
 * (a `%` or `_` a user types is not a wildcard).
 */
export function containsIgnoringCase(column: SQLWrapper, text: string): SQL {
  return sql`${column} ILIKE ${`%${escapeLike(text)}%`} ESCAPE '\\'`
}
