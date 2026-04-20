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
 */
export function createUndoManager(ctx: SlideMutationContext): Y.UndoManager {
  return new Y.UndoManager([ctx.slides], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
  })
}
