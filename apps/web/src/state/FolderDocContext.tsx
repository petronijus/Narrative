/**
 * state/FolderDocContext.tsx
 *
 * React context for a folder's design-token document (`folder:<id>`),
 * separated from FolderDocProvider.tsx for react-refresh compliance.
 *
 * The context exposes:
 *   - `doc`: the live Y.Doc — read-only for the editor since A2.12 (tokens
 *     change through the server, state/folderTokenWriter.ts);
 *   - `tokens`: the folder's tokens (slide-model `readFolderTokens`) with the
 *     user's pending changes over them, re-rendering subscribers on change.
 *
 * Consumed by:
 *   - `useFolderTokens()` — read access to all token categories
 *   - `useFolderTokenWriter()` — changing tokens (FolderDocProvider)
 *   - `TokensContext` — the renderer's synchronous colour resolver
 */

import { createContext } from 'react'
import type * as Y from 'yjs'
import type { FolderTokensSnapshot } from '@narrative/slide-model'

export type { FolderTokensSnapshot }

export interface FolderDocContextValue {
  /** The live Hocuspocus Y.Doc for `folder:<folderId>`. */
  doc: Y.Doc
  /** Live plain-JSON snapshot — re-renders on every Y.Doc mutation. */
  tokens: FolderTokensSnapshot
  /**
   * The folder document has synced with the server at least once. Before
   * that `tokens` is an empty placeholder, not a folder without tokens —
   * commands must not take it for one (state/useCommand.ts).
   */
  synced: boolean
  /**
   * The server refused the folder document (no access to the folder's
   * content). `tokens` then stays the empty placeholder for good.
   */
  refused: boolean
}

export const FolderDocContext = createContext<FolderDocContextValue | null>(null)

// ---------------------------------------------------------------------------
// Empty snapshot helper
// ---------------------------------------------------------------------------

export function emptyTokensSnapshot(): FolderTokensSnapshot {
  return { colors: {}, textStyles: {}, effectStyles: {} }
}
