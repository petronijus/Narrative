/**
 * services/localiseMedia.ts — a deck leaving its folder takes its linked
 * media along (folder sharing, step 2; docs/plans/folder-sharing.md).
 *
 * A deck may show the pictures and videos of its folder's components and of
 * the folder itself without owning them (media/visibleMedia.ts). Moved to
 * another folder it may no longer show them, and nobody of the new folder
 * could load them. So before the deck changes folders, every such asset it
 * references is copied into the deck (deck-owned rows, under its prefix) and
 * the live document is pointed at the copies through the sync server.
 */

import type * as Y from 'yjs'
import type { ServiceDeps } from './deps.js'
import { copyMedia, pointAssetsAt, referencedAssets } from './deckInsert.js'
import { readDocCopy, SERVER_EDIT_ORIGIN, writeLiveDoc } from './liveDocs.js'
import { discardDeckMedia, registerDeckMedia } from '../pptx/importDeck.js'

/**
 * Copy the media of `fromFolderId` that the deck links into the deck, and
 * point the deck at the copies. Idempotent: a deck that links nothing of
 * that folder is read and left alone. Returns how many assets were copied
 * and how many references stay unresolved (their asset is gone or another
 * deck's, or a copy failed — they stay as they were).
 */
export async function localiseLinkedMedia(
  deps: ServiceDeps,
  args: { userId: string; deckId: string; fromFolderId: string; toFolderId: string },
): Promise<{ copied: number; unresolved: number }> {
  const { db, log } = deps
  const deck = { deckId: args.deckId }

  const copy = await readDocCopy(deps, 'deck', args.deckId)
  let assetIds: Set<string>
  try {
    assetIds = referencedAssets(copy.getArray<Y.Map<unknown>>('slides').toArray())
  } finally {
    copy.destroy()
  }
  if (assetIds.size === 0) return { copied: 0, unresolved: 0 }

  // The same deck before and after the move: what it may show in the old
  // folder but not in the new one — its folder's linked media — is copied;
  // its own media is visible in both and stays.
  const staged = await copyMedia(deps, {
    userId: args.userId,
    source: deck,
    sourceFolderId: args.fromFolderId,
    target: deck,
    targetFolderId: args.toFolderId,
    assetIds,
    families: new Set(),
    // Part of moving a deck (its owner, an editor of both folders), not a
    // copy the person asked for one asset at a time.
    budgeted: false,
  })
  // References neither folder could show (a deleted asset, another deck's)
  // and copies that failed: they stay as they were.
  const unresolved = staged.failed
  if (staged.idMap.size === 0) return { copied: 0, unresolved }

  const media = { mediaAssetRows: staged.rows, videoTranscodeJobs: staged.videoJobs }
  await registerDeckMedia({ db, deckId: args.deckId, ownerUserId: args.userId, media, log })
  const touched = { value: false }
  try {
    await writeLiveDoc(
      deps,
      'deck',
      args.deckId,
      (doc) => pointAssetsAt(doc.getArray<Y.Map<unknown>>('slides').toArray(), staged.idMap),
      SERVER_EDIT_ORIGIN,
      touched,
    )
  } catch (err) {
    if (!touched.value) await discardDeckMedia({ db, deckId: args.deckId, media, log })
    throw err
  }
  return { copied: staged.idMap.size, unresolved }
}
