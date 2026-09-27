/**
 * services/shared.ts — small helpers every service uses.
 */

import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { MAX_LIST_PAGE_SIZE, type FontFaceInfo } from '@narrative/commands'
import type { Database } from '../db/client.js'
import { folders } from '../db/schema.js'
import { presignGetUrl } from '../media/s3Client.js'
import type { FontAssetRow } from '../media/assets.js'
import { badRequest, forbidden, notFound } from './errors.js'

/** A timestamp as the API returns it (JSON of a Date is its ISO string). */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value)
}

/** The user ids whose folders / decks a user sees (BYPASS_AUTH dev mode adds the legacy demo user). */
export function ownerIdsFor(userId: string, bypass: boolean | undefined): string[] {
  return bypass === true ? [userId, 'demo-user'] : [userId]
}

/**
 * The folder, which must exist (else 404 "Folder not found") and be owned
 * by the user (else 403). Folders have a single owner; there is no folder ACL.
 */
export async function requireOwnedFolder(
  db: Database,
  folderId: string,
  userId: string,
  opts: { bypass?: boolean | undefined; notFoundMessage?: string } = {},
): Promise<{ id: string; ownerUserId: string; name: string }> {
  const [folder] = await db
    .select({ id: folders.id, ownerUserId: folders.ownerUserId, name: folders.name })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1)
  if (!folder) throw notFound(opts.notFoundMessage ?? 'Folder not found')
  if (!ownerIdsFor(userId, opts.bypass).includes(folder.ownerUserId)) throw forbidden()
  return folder
}

/** A font asset row as the font list endpoints return it (with a fresh presigned URL). */
export async function fontFaceInfo(row: FontAssetRow): Promise<FontFaceInfo> {
  return {
    assetId: row.id,
    family: row.fontFamily,
    weight: row.fontWeight,
    style: row.fontStyle,
    postscriptName: row.fontPostscriptName,
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
