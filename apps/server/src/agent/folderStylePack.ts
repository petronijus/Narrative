/**
 * agent/folderStylePack.ts — the style pack a command's target sees
 * (`ctx.stylePack`, agentic A4.4): its folder's, read from the folder
 * document (live when open, else stored). Loaded by the server host only
 * for commands that declare `readsStylePack`, after it authorised the
 * actor on the target — a deck editor lays out that deck's slides with its
 * folder's pack, as the editor does.
 */

import type { CommandTarget } from '@narrative/commands'
import { readStylePack } from '@narrative/slide-model'
import type { StylePack } from '@narrative/shared'
import type { ServiceDeps } from '../services/deps.js'
import { readDocCopy } from '../services/liveDocs.js'
import { folderOf, type FolderTokensSources } from './folderTokens.js'

/** The target's folder's pack; null when it has no folder or no pack. */
export type FolderStylePackReader = (target: CommandTarget) => Promise<StylePack | null>

/** The reader over where folders come from (the same sources as the tokens'). */
export function createFolderStylePackReader(sources: FolderTokensSources): FolderStylePackReader {
  return async (target) => {
    const folderId = await sources.folderOf(target)
    if (folderId === null) return null
    const doc = await sources.readFolder(folderId)
    try {
      return readStylePack(doc) as StylePack | null
    } finally {
      doc.destroy()
    }
  }
}

/** The production reader: the folder from the database, its document live or stored. */
export function createDbFolderStylePackReader(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
): FolderStylePackReader {
  return createFolderStylePackReader({
    folderOf: (target) => folderOf(deps.db, target),
    readFolder: (folderId) => readDocCopy(deps, 'folder', folderId),
  })
}
