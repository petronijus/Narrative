/**
 * agent/folderStylePack.ts — the style pack a command's target sees
 * (`ctx.stylePack`, agentic A4.4): its folder's, read from the folder
 * document (live when open, else stored). Loaded by the server host only
 * for commands that declare `readsStylePack`, after it authorised the
 * actor on the target — a deck editor lays out that deck's slides with its
 * folder's pack, as the editor does. Kept within a run while the folder
 * document is unchanged (agent/folderReads.ts).
 */

import type { CommandTarget } from '@narrative/commands'
import { readStylePack } from '@narrative/slide-model'
import type { StylePack } from '@narrative/shared'
import type { ServiceDeps } from '../services/deps.js'
import { createDbFolderSources, type FolderTokensSources } from './folderTokens.js'
import { readFolderDerived, scopedFolderOf, type FolderReadScope } from './folderReads.js'

/** The target's folder's pack; null when it has no folder or no pack. `scope`: as the tokens'. */
export type FolderStylePackReader = (
  target: CommandTarget,
  scope?: FolderReadScope,
) => Promise<StylePack | null>

/** The reader over where folders come from (the same sources as the tokens'). */
export function createFolderStylePackReader(sources: FolderTokensSources): FolderStylePackReader {
  return async (target, scope) => {
    const folderId = await scopedFolderOf(sources, target, scope)
    if (folderId === null) return null
    return readFolderDerived(
      sources,
      folderId,
      'stylePack',
      scope,
      (doc) => readStylePack(doc) as StylePack | null,
    )
  }
}

/** The production reader: the folder from the database, its document live or stored. */
export function createDbFolderStylePackReader(
  deps: Pick<ServiceDeps, 'db' | 'log' | 'hocuspocus'>,
): FolderStylePackReader {
  return createFolderStylePackReader(createDbFolderSources(deps))
}
