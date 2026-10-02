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
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
  })
}

/**
 * Outside a gesture, local changes less than this far apart merge into one
 * undo step (Yjs' capture window): typing a word, holding an arrow key.
 */
export const UNDO_CAPTURE_TIMEOUT_MS = 500

/**
 * Gestures — a drag, a resize, a slider pulled with the pointer — write a
 * change per frame. Left to the capture window, a gesture is one undo step
 * only while no two of its frames are more than 500 ms apart: a pause
 * mid-drag, or a busy machine, splits it into several steps, and a gesture
 * that follows another within 500 ms merges into it. A gesture is one step
 * by its boundaries instead:
 *
 *   - `beginUndoGesture` closes the step before (nothing merges into it) and
 *     lifts the time limit, so every change until the end joins one step;
 *   - `endUndoGesture` restores the capture window and closes the step, so
 *     the next change starts a new one.
 *
 * The editor marks pointer gestures this way (web `state/undoGestures.ts`).
 */
export function beginUndoGesture(undoManager: Y.UndoManager): void {
  undoManager.stopCapturing()
  undoManager.captureTimeout = Number.POSITIVE_INFINITY
}

/** Ends a gesture opened by {@link beginUndoGesture}. */
export function endUndoGesture(undoManager: Y.UndoManager): void {
  undoManager.captureTimeout = UNDO_CAPTURE_TIMEOUT_MS
  undoManager.stopCapturing()
}
