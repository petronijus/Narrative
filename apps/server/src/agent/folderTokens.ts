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
 */

import { eq } from 'drizzle-orm'
import type * as Y from 'yjs'
import type { CommandTarget } from '@narrative/commands'
import type { FolderTokensSnapshot } from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import { components, decks } from '../db/schema.js'
import type { ServiceDeps } from '../services/deps.js'
import { readDocCopy } from '../services/liveDocs.js'
import { tokensSnapshot } from '../services/tokenRebind.js'

/** The target's folder tokens; null when it has no folder or the folder has no tokens yet. */
export type FolderTokensReader = (target: CommandTarget) => Promise<FolderTokensSnapshot | null>

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

export interface FolderTokensSources {
  /** The folder the target belongs to, or null. */
  folderOf(target: CommandTarget): Promise<string | null>
  /** A detached copy of the folder document; the reader destroys it. */
  readFolder(folderId: string): Promise<Y.Doc>
}

export function createFolderTokensReader(sources: FolderTokensSources): FolderTokensReader {
  return async (target) => {
    const folderId = await sources.folderOf(target)
    if (folderId === null) return null
    const doc = await sources.readFolder(folderId)
    try {
      const snapshot = tokensSnapshot(doc)
      const empty =
        Object.keys(snapshot.colors).length === 0 &&
        Object.keys(snapshot.textStyles).length === 0 &&
        Object.keys(snapshot.effectStyles).length === 0
      return empty ? null : snapshot
    } finally {
      doc.destroy()
    }
  }
}

/** The production reader: the folder from the database, its document live or stored. */
export function createDbFolderTokensReader(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
): FolderTokensReader {
  return createFolderTokensReader({
    folderOf: (target) => folderOf(deps.db, target),
    readFolder: (folderId) => readDocCopy(deps, 'folder', folderId),
  })
}
