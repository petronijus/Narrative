/**
 * state/FolderDocContext.tsx
 *
 * M16 P2 — React context for a folder's design-token Y.Doc.
 *
 * Separated from FolderDocProvider.tsx for react-refresh compliance.
 *
 * The context exposes:
 *   - `doc`: the live Y.Doc for `folder:<folderId>`
 *   - `tokens`: a live plain-JSON snapshot of `{ colors, textStyles, effectStyles }`
 *     that re-renders subscribers whenever the Y.Doc changes
 *
 * Consumed by:
 *   - `useFolderTokens()` — hook for read access to all token categories
 *   - `FolderDocProvider` — mutation helpers (addToken, updateToken, deleteToken)
 *   - `TokensContext` — renderer's synchronous colour resolver
 */

import { createContext } from 'react'
import type * as Y from 'yjs'
import type {
  ColorTokenSnapshot,
  TextStyleTokenSnapshot,
  EffectStyleTokenSnapshot,
} from '@narrative/slide-model'

export interface FolderTokensSnapshot {
  colors: Record<string, ColorTokenSnapshot>
  textStyles: Record<string, TextStyleTokenSnapshot>
  effectStyles: Record<string, EffectStyleTokenSnapshot>
  /**
   * CRDT-replicated set of component ids that have been deleted from this
   * folder. Written by the client that calls `api.deleteComponent` via
   * `markComponentDeleted(folderId, componentId)`. Every peer observing the
   * folder Y.Doc receives the write and can sweep its open deck accordingly.
   *
   * Stored as a Y.Array of strings on the folder doc (key `deletedComponentIds`).
   * Duplicate entries are possible when two peers concurrently delete the same
   * master — consumers should deduplicate via a Set.
   */
  deletedComponentIds: ReadonlySet<string>
}

export interface FolderDocContextValue {
  /** The live Hocuspocus Y.Doc for `folder:<folderId>`. */
  doc: Y.Doc
  /** Live plain-JSON snapshot — re-renders on every Y.Doc mutation. */
  tokens: FolderTokensSnapshot
}

export const FolderDocContext = createContext<FolderDocContextValue | null>(null)

// ---------------------------------------------------------------------------
// Empty snapshot helper
// ---------------------------------------------------------------------------

export function emptyTokensSnapshot(): FolderTokensSnapshot {
  return { colors: {}, textStyles: {}, effectStyles: {}, deletedComponentIds: new Set() }
}
