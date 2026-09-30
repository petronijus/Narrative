/**
 * media/mediaOwner.ts
 *
 * Who a picture or video belongs to, and where its bytes live.
 *
 * A `media_assets` row has exactly one owner (A2.12b, migration 0027):
 *
 *   - a deck       — `deck_id`; keys under `decks/<deckId>/…`;
 *   - a component  — `component_id` (a component master's own pictures and
 *                    videos); keys under `components/<componentId>/…`;
 *                    `deck_id` and `folder_id` are NULL;
 *   - a folder     — `folder_id`, fonts only (the folder fonts path,
 *                    services/folders.ts), never through this module.
 *
 * Access follows the owner: deck media by the deck's role (share links
 * included); component media is read by whoever may read its folder's
 * content (members, and guests of the folder's decks — share links
 * included) and uploaded or deleted by the folder's editors, the rule of the
 * `component:<id>` document (docs/plans/folder-sharing.md).
 *
 * The tus upload id is a compound `<assetId>:<deckId|unknown>:<base64url(path)>`
 * and is also the object's S3 key (@tus/s3-store keys objects by upload id).
 * A component upload puts `unknown` in the deck slot; its owner is the
 * `componentId` of the upload's stored metadata, and its path starts with
 * `components/<componentId>/`.
 */

import type { DocumentRef } from '@narrative/commands'
import { eq } from 'drizzle-orm'
import {
  resolveComponentAccess,
  resolveFolderContentAccess,
  roleAtLeast,
  type DeckRole,
} from '../auth/permissions.js'
import type { Database } from '../db/client.js'
import { components } from '../db/schema.js'

/**
 * The owner of a picture or video: the document it belongs to (the
 * commands' `DocumentRef`). Fonts belong to folders and are not a MediaOwner.
 */
export type MediaOwner = DocumentRef

/**
 * The ids that may name a storage key segment: the nanoid alphabet. A deck
 * or component id is one segment of every key its owner stores
 * (`components/<id>/…`); an id with a slash or a dot would reach into
 * another owner's keys. Until A2.12b the component create route accepted a
 * client-chosen id, so a legacy row may hold such an id (migration 0028
 * refuses new ones).
 */
const STORAGE_SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Whether `id` may be a storage key segment (see STORAGE_SAFE_ID). */
export function isStorageSafeId(id: string): boolean {
  return STORAGE_SAFE_ID.test(id)
}

/**
 * `decks/<deckId>` or `components/<componentId>` — the key prefix of
 * everything the owner stores. Throws for an id that is not storage safe:
 * nothing may be stored under, or purged from, a prefix it would widen.
 */
export function mediaOwnerPrefix(owner: MediaOwner): string {
  const [kind, id] =
    'componentId' in owner ? ['components', owner.componentId] : ['decks', owner.deckId]
  if (!isStorageSafeId(id)) {
    throw new Error(
      `${kind === 'decks' ? 'deck' : 'component'} id ${JSON.stringify(id)} cannot name storage keys`,
    )
  }
  return `${kind}/${id}`
}

/**
 * The storage path of an uploaded original:
 * `<owner prefix>/<uploads|fonts>/<assetId>/original.<ext>`. Fonts go under
 * `fonts/` (a deck's legacy fonts); a component takes no fonts.
 */
export function mediaOriginalPath(
  owner: MediaOwner,
  folder: 'uploads' | 'fonts',
  assetId: string,
  ext: string,
): string {
  return `${mediaOwnerPrefix(owner)}/${folder}/${assetId}/original.${ext}`
}

/** The deck slot of a compound upload id that is bound to no deck. */
export const NO_DECK_SLOT = 'unknown'

/** Builds the compound tus upload id `<assetId>:<deckId|unknown>:<base64url(path)>`. */
export function encodeTusUploadId(assetId: string, deckId: string | null, path: string): string {
  return `${assetId}:${deckId ?? NO_DECK_SLOT}:${Buffer.from(path).toString('base64url')}`
}

export interface ParsedTusUploadId {
  assetId: string
  /** The deck slot, or null when it holds `unknown` (a folder pptx import, a component upload). */
  deckId: string | null
  /** The decoded storage path, or null when the third field is missing. */
  path: string | null
}

/** Parses a compound tus upload id; null when it is not one (no asset id). */
export function parseTusUploadId(id: string): ParsedTusUploadId | null {
  const [assetId, deckSlot, encodedPath] = id.split(':')
  if (!assetId || !deckSlot) return null
  return {
    assetId,
    deckId: deckSlot === NO_DECK_SLOT ? null : deckSlot,
    path: encodedPath ? Buffer.from(encodedPath, 'base64url').toString('utf8') : null,
  }
}

/**
 * The user's role in the folder a component lives in, which is what they
 * may do with the component's pictures and videos: a viewer reads them, an
 * editor also uploads and deletes them. Exactly the rule of the component's
 * Y.Doc (hocuspocus/authenticate.ts). A missing component, or a user
 * outside the folder, answers null.
 */
export async function componentMediaRole(
  db: Database,
  componentId: string,
  userId: string | null,
): Promise<DeckRole | null> {
  if (userId === null || userId === '') return null
  return (await resolveComponentAccess(db, { componentId, userId }))?.role ?? null
}

/** Whether the user may upload a component's media or delete it: an editor of its folder. */
export async function canWriteComponentMedia(
  db: Database,
  componentId: string,
  userId: string | null,
): Promise<boolean> {
  const role = await componentMediaRole(db, componentId, userId)
  return role !== null && roleAtLeast(role, 'editor')
}

/**
 * Whether the user — or the holder of a share link — may SEE a component's
 * picture or video: whoever may read the content of the component's folder
 * (a member, or anyone with access to one of its decks, a share link
 * included), so a component stamped on a shared deck shows for its guests
 * (docs/plans/folder-sharing.md). A missing component answers false.
 */
export async function canReadComponentMedia(
  db: Database,
  componentId: string,
  userId: string | null,
  shareToken: string | null | undefined,
): Promise<boolean> {
  const [row] = await db
    .select({ folderId: components.folderId })
    .from(components)
    .where(eq(components.id, componentId))
    .limit(1)
  if (!row) return false
  const access = await resolveFolderContentAccess(db, {
    folderId: row.folderId,
    userId: userId === '' ? null : userId,
    shareToken: shareToken ?? null,
  })
  return access !== null
}
