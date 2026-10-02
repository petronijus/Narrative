/**
 * state/undoGestures.ts — every pointer gesture is one undo step.
 *
 * A drag, a resize, a column boundary, a slider pulled with the pointer:
 * each writes a change per frame, and until 2026-10-02 the undo manager's
 * 500 ms capture window was what made them one step — a pause mid-drag or a
 * busy machine split a gesture into several steps, and a gesture right after
 * another merged into it (slide-model `undo.ts`). The gesture's boundaries
 * decide instead: pressing the pointer opens it, releasing the last pointer
 * closes it.
 *
 *   - Opens on `pointerdown` in the CAPTURE phase on the window, before the
 *     target's own handler runs — Alt-drag writes its copy on pointerdown,
 *     and that copy belongs to the gesture.
 *   - Closes a task after the last `pointerup` / `pointercancel`: the
 *     gestures' own pointerup handlers (on the element, or on the window,
 *     registered when the drag began — after this one) still write their
 *     final frame; closing synchronously would make that frame a step of
 *     its own.
 *   - A new primary pointer always starts a new gesture: a release the
 *     window never saw (the button let go outside it) cannot keep a gesture
 *     open into the next one. A window blur closes it too.
 *
 * Keyboard edits keep the capture window (typing a word, holding an arrow
 * key merge as before).
 */

import { useEffect } from 'react'
import type * as Y from 'yjs'
import { beginUndoGesture, endUndoGesture } from '@narrative/slide-model'

/** Mark the window's pointer gestures as undo steps of `undoManager` while mounted. */
export function usePointerUndoGestures(undoManager: Y.UndoManager | null | undefined): void {
  useEffect(() => {
    if (undoManager === null || undoManager === undefined) return
    const pointers = new Set<number>()
    // Which gesture a scheduled close belongs to: a new gesture opened in
    // the meantime must not be closed by the previous one's timer.
    let gesture = 0
    let open = false
    let closing: ReturnType<typeof setTimeout> | null = null

    const close = () => {
      if (closing !== null) clearTimeout(closing)
      closing = null
      if (open) endUndoGesture(undoManager)
      open = false
    }
    const onDown = (e: PointerEvent) => {
      if (e.isPrimary) {
        close()
        pointers.clear()
      }
      if (!open) {
        gesture++
        beginUndoGesture(undoManager)
        open = true
      }
      pointers.add(e.pointerId)
    }
    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId) || pointers.size > 0) return
      const ending = gesture
      if (closing !== null) clearTimeout(closing)
      closing = setTimeout(() => {
        closing = null
        if (ending === gesture) close()
      }, 0)
    }
    const onBlur = () => {
      pointers.clear()
      close()
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('blur', onBlur)
      close()
    }
  }, [undoManager])
}
