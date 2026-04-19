/**
 * slide-model/src/undo.ts
 *
 * Y.UndoManager factory s filtrováním na LOCAL_ORIGIN.
 * Remote changes (budoucí M4 Hocuspocus sync) mají jiný origin a nebudou
 * zahrnuty do undo stacku klienta.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import type { MutationContext } from './mutations.js'

/**
 * Vytvoří Y.UndoManager pro objects array.
 * Trackuje pouze operace s LOCAL_ORIGIN — lokální user edity.
 */
export function createUndoManager(ctx: MutationContext): Y.UndoManager {
  return new Y.UndoManager(ctx.objects, {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
  })
}
