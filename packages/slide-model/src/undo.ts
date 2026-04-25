/**
 * slide-model/src/undo.ts
 *
 * Y.UndoManager factory with LOCAL_ORIGIN filtering.
 * Remote changes (Hocuspocus sync) have a different origin → excluded from undo stack.
 *
 * M9 update: UndoManager now tracks the top-level 'slides' Y.Array.
 * Y.UndoManager tracks nested Y.Maps and Y.Arrays recursively when given
 * a top-level Y.Array, so undo/redo works for:
 *   - slide add/remove/reorder
 *   - object mutations inside any slide
 *   - animation mutations inside any slide
 *   - transition updates
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import type { SlideMutationContext } from './slideMutationContext.js'

/**
 * Creates Y.UndoManager tracking the slides Y.Array (and all nested content).
 * Tracks only operations with LOCAL_ORIGIN — local user edits only.
 *
 * P11: also tracks the deck-level `guides` Y.Array so add/move/remove of
 * a ruler-dragged guide takes part in undo/redo.
 */
export function createUndoManager(ctx: SlideMutationContext): Y.UndoManager {
  const guides = ctx.doc.getArray<Y.Map<unknown>>('guides')
  return new Y.UndoManager([ctx.slides, guides], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
  })
}
