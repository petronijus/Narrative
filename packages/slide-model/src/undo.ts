/**
 * slide-model/src/undo.ts
 *
 * Y.UndoManager factory s filtrováním na LOCAL_ORIGIN.
 * Remote changes (budoucí M4 Hocuspocus sync) mají jiný origin a nebudou
 * zahrnuty do undo stacku klienta.
 *
 * M6 update: UndoManager trackuje obě Y.Array — objects i animations —
 * takže undo/redo funguje i pro animační změny.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import type { SlideMutationContext } from './slideMutationContext.js'

/**
 * Vytvoří Y.UndoManager pro objects i animations array.
 * Trackuje pouze operace s LOCAL_ORIGIN — lokální user edity.
 */
export function createUndoManager(ctx: SlideMutationContext): Y.UndoManager {
  return new Y.UndoManager([ctx.objects, ctx.animations], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
  })
}
