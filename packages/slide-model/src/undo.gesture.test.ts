/**
 * slide-model/src/undo.gesture.test.ts
 *
 * A gesture is one undo step by its boundaries, not by timing
 * (`beginUndoGesture` / `endUndoGesture`). Left to the 500 ms capture
 * window, a drag whose frames came more than 500 ms apart — a pause
 * mid-drag, a busy machine — split into several steps, and a gesture
 * following another within 500 ms merged into it (found 2026-10-02 when the
 * e2e suite ran in parallel: "dragging a column boundary … as one undo
 * step" undid only the last frames).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from './mutations.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, type SlideMutationContext } from './slides.js'
import {
  beginUndoGesture,
  createUndoManager,
  endUndoGesture,
  UNDO_CAPTURE_TIMEOUT_MS,
} from './undo.js'

function deck() {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  addSlide(ctx)
  const undoManager = createUndoManager(ctx)
  const slide = slides.get(0) as Y.Map<unknown>
  /**
   * One local change, `ms` after the previous one. Yjs reads the clock
   * through lib0, which keeps its own `Date.now`, so fake timers do not
   * reach it; the time since the last change is moved back instead — it is
   * exactly what the capture decision compares.
   */
  const write = (value: number, ms = 16) => {
    if (undoManager.lastChange > 0) undoManager.lastChange -= ms
    doc.transact(() => slide.set('probe', value), LOCAL_ORIGIN)
  }
  const value = () => slide.get('probe')
  return { undoManager, write, value }
}

describe('undo gestures', () => {
  it('keep a slow gesture one step, however far apart its changes are', () => {
    const { undoManager, write, value } = deck()
    write(0)
    undoManager.stopCapturing()

    beginUndoGesture(undoManager)
    write(1)
    write(2, 2_000) // the pointer rests for two seconds mid-drag
    write(3, 5_000)
    endUndoGesture(undoManager)

    undoManager.undo()
    expect(value()).toBe(0)
  })

  it('never merge a gesture into the change just before it', () => {
    const { undoManager, write, value } = deck()
    write(0)
    beginUndoGesture(undoManager)
    write(1, 10) // well inside the capture window
    endUndoGesture(undoManager)

    undoManager.undo()
    expect(value()).toBe(0)
  })

  it('start a new step for the change right after a gesture', () => {
    const { undoManager, write, value } = deck()
    beginUndoGesture(undoManager)
    write(1)
    endUndoGesture(undoManager)
    write(2, 10)

    undoManager.undo()
    expect(value()).toBe(1)
  })

  it('leave the capture window as it was outside gestures', () => {
    const { undoManager, write, value } = deck()
    beginUndoGesture(undoManager)
    endUndoGesture(undoManager)
    expect(undoManager.captureTimeout).toBe(UNDO_CAPTURE_TIMEOUT_MS)

    write(0)
    undoManager.stopCapturing()
    write(1, 10)
    write(2, 10) // typing: merges
    write(3, UNDO_CAPTURE_TIMEOUT_MS + 1) // a pause: a new step
    undoManager.undo()
    expect(value()).toBe(2)
    undoManager.undo()
    expect(value()).toBe(0)
  })
})
