/**
 * media/visibleMedia.ts — which media a document may show (folder sharing,
 * step 2: linked component media; docs/plans/folder-sharing.md).
 *
 * A deck or a component master shows its own rows, and — linked, never
 * copied — the pictures and videos of its folder: those of every component
 * in the folder (a stamp of a master points at the master's own picture)
 * and those the folder itself owns (a deleted component's media is handed
 * to its folder, so is a picture deleted from a master). Only pictures and
 * videos link: the folder's fonts are not media a slide shows by asset id
 * (they are read by family through the folder's font list). Another deck's
 * media is never visible: deck media is copied whenever it crosses into
 * another document.
 *
 * The copy rules (`services/deckInsert.ts` copyMedia), the read rules
 * (`services/media.ts`) and the PowerPoint export all ask this one question.
 */

import { and, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { components, decks, mediaAssets } from '../db/schema.js'
import type { MediaOwner } from './mediaOwner.js'

/** A document that shows media: a deck or a component master, with its folder. */
export interface MediaHolder {
  owner: MediaOwner
  /** The holder's folder; null for a deck in no folder (it shows only its own media). */
  folderId: string | null
}

/** Where a media row belongs, as far as visibility goes. */
export interface MediaPlacement {
  deckId: string | null
  componentId: string | null
  folderId: string | null
  /** The folder of `componentId`'s component (null when the row is not a component's). */
  componentFolderId: string | null
  kind: 'image' | 'video' | 'font'
}

/** The kinds a document may link from its folder (its components' and the folder's own). */
export const LINKABLE_KINDS = ['image', 'video'] as const

/** Whether `row` is a picture or video a document of its folder may link. */
export function isLinkable(row: Pick<MediaPlacement, 'kind'>): boolean {
  return (LINKABLE_KINDS as readonly string[]).includes(row.kind)
}

/**
 * The folder whose documents may link `row` — its component's folder, or
 * the folder that owns it — or null for a deck's row and anything that is
 * not a picture or video.
 */
export function linkFolderOf(row: MediaPlacement): string | null {
  if (row.deckId !== null || !isLinkable(row)) return null
  if (row.componentId !== null) return row.componentFolderId
  return row.folderId
}

/** Whether `holder` may show the media row placed at `row`. */
export function visibleIn(row: MediaPlacement, holder: MediaHolder): boolean {
  const { owner, folderId } = holder
  if ('deckId' in owner && row.deckId === owner.deckId) return true
  if ('componentId' in owner && row.componentId === owner.componentId) return true
  if (folderId === null) return false
  return linkFolderOf(row) === folderId
}

/**
 * The SQL condition for the rows `holder` may show — `visibleIn` for a
 * query that joins `components` on `media_assets.component_id` (left join:
 * deck and folder rows have no component).
 */
export function visibleInSql(holder: MediaHolder): SQL {
  const { owner, folderId } = holder
  const own =
    'deckId' in owner
      ? eq(mediaAssets.deckId, owner.deckId)
      : eq(mediaAssets.componentId, owner.componentId)
  if (folderId === null) return own
  return or(
    own,
    and(
      inArray(mediaAssets.kind, [...LINKABLE_KINDS]),
      or(
        and(isNotNull(mediaAssets.componentId), eq(components.folderId, folderId)),
        eq(mediaAssets.folderId, folderId),
      ),
    ),
  ) as SQL
}

/** Every column of the rows `ids`, each with its placement (component folder joined). */
export async function readPlacedMedia(db: Database, ids: readonly string[]) {
  if (ids.length === 0) return []
  const rows = await db
    .select({ row: mediaAssets, componentFolderId: components.folderId })
    .from(mediaAssets)
    .leftJoin(components, eq(components.id, mediaAssets.componentId))
    .where(inArray(mediaAssets.id, [...ids]))
  return rows.map(({ row, componentFolderId }) => ({
    ...row,
    componentFolderId: componentFolderId ?? null,
  }))
}

/** The folder of a deck or a component master; null for a deck in no folder or one that does not exist. */
export async function folderOfOwner(db: Database, owner: MediaOwner): Promise<string | null> {
  const [row] =
    'deckId' in owner
      ? await db
          .select({ folderId: decks.folderId })
          .from(decks)
          .where(eq(decks.id, owner.deckId))
          .limit(1)
      : await db
          .select({ folderId: components.folderId })
          .from(components)
          .where(eq(components.id, owner.componentId))
          .limit(1)
  return row?.folderId ?? null
}
