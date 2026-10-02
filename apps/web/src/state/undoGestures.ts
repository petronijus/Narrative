/**
 * state/undoGestures.ts — every pointer gesture is one undo step.
 *
 * A drag, a resize, a column boundary, a slider pulled with the pointer:
 * each writes a change per frame, and until 2026-10-02 the undo manager's
 * 500 ms capture window was what made them one step — a pause mid-drag or a
 * busy machine split a gesture into several steps, and a gesture right after
 * another merged into it (slide-model `undo.ts`). The gesture's boundaries
 * decide instead: pressing the primary button opens it, releasing the last
 * pointer closes it.
 *
 *   - Opens on `pointerdown` in the CAPTURE phase on the window, before the
 *     target's own handler runs — Alt-drag writes its copy on pointerdown,
 *     and that copy belongs to the gesture. Only the primary button: the
 *     right button opens a context menu (whose items are clicks of their
 *     own), and a native menu or `<select>` popup can swallow the release.
 *     A `<select>` never opens one: it writes once, on `change`.
 *   - Closes a task after the last `pointerup` / `pointercancel`: the
 *     gesture's own handlers (pointerup on the element or on the window,
 *     and the `click` dispatched after it) still write its final change;
 *     closing synchronously would make that change a step of its own.
 *   - A release the window never saw — the button let go outside the
 *     window, over a native menu — is noticed on the next pointer move with
 *     no button held (`buttons === 0`), on the next primary pointerdown, or
 *     when the window loses focus. Without that, every later keyboard edit
 *     would join the open gesture.
 *
 * Keyboard edits outside a gesture keep the capture window (typing a word,
 * holding an arrow key merge as before). A keyboard change made while the
 * pointer is held — Shift or Alt pressed mid-drag, which replays the frame
 * (`useDragModifierReplay`) — belongs to that gesture, on purpose.
 */

import { useEffect } from 'react'
import type * as Y from 'yjs'
import { beginUndoGesture, endUndoGesture } from '@narrative/slide-model'

/** The primary button (left mouse button, a touch, a pen tip). */
const PRIMARY_BUTTON = 0

function opensGesture(e: PointerEvent): boolean {
  if (e.button !== PRIMARY_BUTTON) return false
  const target = e.target
  return !(target instanceof Element && target.closest('select') !== null)
}

/** Mark the window's pointer gestures as undo steps of `undoManager` while mounted. */
export function usePointerUndoGestures(undoManager: Y.UndoManager | null | undefined): void {
  useEffect(() => {
    if (undoManager === null || undoManager === undefined) return
    const pointers = new Set<number>()
    let open = false
    // A close waiting for the gesture's last handlers (see the header).
    let closing: ReturnType<typeof setTimeout> | null = null

    const close = () => {
      if (closing !== null) clearTimeout(closing)
      closing = null
      pointers.clear()
      if (open) endUndoGesture(undoManager)
      open = false
    }
    const release = (pointerId: number) => {
      if (!pointers.delete(pointerId) || pointers.size > 0 || closing !== null) return
      closing = setTimeout(close, 0)
    }
    const onDown = (e: PointerEvent) => {
      if (!opensGesture(e)) return
      // A new primary pointer starts a new gesture, whatever was left open;
      // another finger joining a gesture keeps it open.
      if (e.isPrimary) close()
      else if (closing !== null) {
        clearTimeout(closing)
        closing = null
      }
      if (!open) {
        beginUndoGesture(undoManager)
        open = true
      }
      pointers.add(e.pointerId)
    }
    const onUp = (e: PointerEvent) => release(e.pointerId)
    // A pointer that moves with no button held was released where the
    // window could not see it.
    const onMove = (e: PointerEvent) => {
      if (e.buttons === 0 && pointers.has(e.pointerId)) release(e.pointerId)
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('blur', close)
      close()
    }
  }, [undoManager])
}
