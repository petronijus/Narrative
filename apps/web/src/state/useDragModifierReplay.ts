/**
 * state/useDragModifierReplay.ts
 *
 * Drag modifiers act live. Pointer handlers only see modifier state when
 * the pointer moves, so pressing or releasing Shift (constrain / aspect
 * lock) or ⌘ / Ctrl (snapping) with the mouse held still would do
 * nothing until the next twitch. This hook remembers the last pointer
 * sample of the gesture and, when one of those modifiers changes, hands
 * it back to the gesture's frame function with the new modifier state.
 *
 * The frame functions it drives are idempotent — each frame is computed
 * from the pointer-down snapshot plus the current pointer, never from
 * the previous frame — so a replayed frame is exactly the frame the next
 * pointermove would produce.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'

export interface DragModifiers {
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

/** The part of a pointer event a drag frame reads. `PointerEvent` satisfies it. */
export interface DragPointer extends DragModifiers {
  readonly clientX: number
  readonly clientY: number
}

const REPLAYED_KEYS = new Set(['Shift', 'Control', 'Meta'])

export interface DragModifierReplay {
  /** Record the pointer sample a frame was just computed from. */
  track: (pointer: DragPointer) => void
  /** The gesture ended; modifier changes stop replaying. */
  end: () => void
}

/**
 * @param frame The gesture's frame function. It must itself ignore calls
 *   when no gesture is in flight; the latest `frame` is always used, so
 *   callers need not memoise it.
 */
export function useDragModifierReplay(frame: (pointer: DragPointer) => void): DragModifierReplay {
  const lastRef = useRef<DragPointer | null>(null)
  const frameRef = useRef(frame)
  // Committed before any key event of the next frame can arrive, so a
  // replay always runs the frame function of the latest render.
  useLayoutEffect(() => {
    frameRef.current = frame
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Auto-repeat of a held modifier changes nothing.
      if (e.repeat || !REPLAYED_KEYS.has(e.key)) return
      const last = lastRef.current
      if (last === null) return
      const next: DragPointer = {
        clientX: last.clientX,
        clientY: last.clientY,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      }
      lastRef.current = next
      frameRef.current(next)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
    }
  }, [])

  const track = useCallback((pointer: DragPointer) => {
    lastRef.current = {
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      shiftKey: pointer.shiftKey,
      ctrlKey: pointer.ctrlKey,
      metaKey: pointer.metaKey,
    }
  }, [])
  const end = useCallback(() => {
    lastRef.current = null
  }, [])

  return useMemo(() => ({ track, end }), [track, end])
}
