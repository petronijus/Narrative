/**
 * agent/folderTokens.ts — the design tokens a command's target sees
 * (`ctx.folderTokens`): those of the folder the deck or component master
 * belongs to, read from the folder document — live when someone has it
 * open, else the stored copy (services/liveDocs.ts `readDocCopy`).
 *
 * The server host loads them only for commands that declare
 * `readsFolderTokens` (or a batch containing one), after it has authorised
 * the actor on the target: a deck editor's command may then resolve the
 * folder's colours and apply its text styles to that deck, as the editor
 * does for them. The snapshot is never returned to the caller as such.
 * Within a run the snapshot is kept while the folder document is unchanged
 * (agent/folderReads.ts).
 */

import { eq, sql } from 'drizzle-orm'
import type { CommandTarget } from '@narrative/commands'
import { readFolderTokens, type FolderTokensSnapshot } from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import { components, decks, folderUpdates } from '../db/schema.js'
import type { ServiceDeps } from '../services/deps.js'
import { loadedDocument, readDocCopy } from '../services/liveDocs.js'
import {
  liveDocumentVersion,
  readFolderDerived,
  scopedFolderOf,
  type FolderDocumentSources,
  type FolderDocumentVersion,
  type FolderReadScope,
} from './folderReads.js'

/**
 * The target's folder tokens; null when it has no folder or the folder has
 * no tokens yet. `scope`: the command's (and its run's) shared reads.
 */
export type FolderTokensReader = (
  target: CommandTarget,
  scope?: FolderReadScope,
) => Promise<FolderTokensSnapshot | null>

/** The folder a command target belongs to (the database's decks / components row), or null. */
export async function folderOf(db: Database, target: CommandTarget): Promise<string | null> {
  if (target.folderId !== undefined) return target.folderId
  if (target.deckId !== undefined) {
    const [row] = await db
      .select({ folderId: decks.folderId })
      .from(decks)
      .where(eq(decks.id, target.deckId))
      .limit(1)
    return row?.folderId ?? null
  }
  if (target.componentId !== undefined) {
    const [row] = await db
      .select({ folderId: components.folderId })
      .from(components)
      .where(eq(components.id, target.componentId))
      .limit(1)
    return row?.folderId ?? null
  }
  return null
}

/** Where the folder document comes from (agent/folderReads.ts). */
export type FolderTokensSources = FolderDocumentSources

export function createFolderTokensReader(sources: FolderTokensSources): FolderTokensReader {
  return async (target, scope) => {
    const folderId = await scopedFolderOf(sources, target, scope)
    if (folderId === null) return null
    return readFolderDerived(sources, folderId, 'tokens', scope, (doc) => {
      const snapshot = readFolderTokens(doc)
      const empty =
        Object.keys(snapshot.colors).length === 0 &&
        Object.keys(snapshot.textStyles).length === 0 &&
        Object.keys(snapshot.effectStyles).length === 0
      return empty ? null : snapshot
    })
  }
}

/**
 * The folder document's version (agent/folderReads.ts): the loaded
 * document's, else the id of its newest stored row — an index-only lookup
 * on `folder_updates (folder_id, id)`.
 */
export async function folderDocumentVersion(
  deps: Pick<ServiceDeps, 'db' | 'hocuspocus'>,
  folderId: string,
): Promise<FolderDocumentVersion> {
  const live = loadedDocument(deps, 'folder', folderId)
  if (live !== null) return liveDocumentVersion(live)
  const [row] = await deps.db
    .select({ id: sql<number | null>`max(${folderUpdates.id})` })
    .from(folderUpdates)
    .where(eq(folderUpdates.folderId, folderId))
  return `stored:${row?.id ?? 'none'}`
}

/** The production sources: the folder from the database, its document live or stored. */
export function createDbFolderSources(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
): FolderDocumentSources {
  return {
    folderOf: (target) => folderOf(deps.db, target),
    readFolder: (folderId) => readDocCopy(deps, 'folder', folderId),
    version: (folderId) => folderDocumentVersion(deps, folderId),
  }
}

/** The production reader: the folder from the database, its document live or stored. */
export function createDbFolderTokensReader(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
): FolderTokensReader {
  return createFolderTokensReader(createDbFolderSources(deps))
}
