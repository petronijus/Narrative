/**
 * state/useAwarenessUpdater.ts
 *
 * Write API pro lokální awareness state.
 *
 * M8: Skutečná implementace. Zapíše do Y.Awareness přes SlideDocContext.
 *
 * Throttling kurzoru:
 *   setCursor() je throttlován na max 30 Hz (33ms interval) vlastní mini impl
 *   bez lodash nebo jiných závislostí (dle spike B doporučení a task scope).
 *
 *   Pattern: "trailing RAF throttle"
 *   - Pokud od posledního emit uběhlo ≥ 33ms → emit okamžitě
 *   - Pokud ne → uložit jako pending, naplánovat rAF flush
 *   - setCursor(null) vždy emit okamžitě — žádné "ghost cursor" po opuštění canvasu
 *
 * Selection a userName jsou immediate (nízká frekvence, žádný throttle).
 *
 * Merge pattern: čte current local state, merge, setLocalState(full) —
 * nikdy nenastavuje jen jeden field, aby neztratil ostatní fields.
 */

import { useCallback, useRef, useEffect } from 'react'
import type { PeerCursor, PeerAwarenessState } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AwarenessUpdater {
  /**
   * Broadcastuje pozici kurzoru ostatním peerům.
   * Throttled 30 Hz — volej klidně na každý pointermove.
   * null = kurzor mimo canvas → emit okamžitě (bez throttle).
   */
  setCursor: (cursor: PeerCursor | null) => void
  /**
   * Broadcastuje lokální selection. Immediate (nízká frekvence).
   * Akceptuje readonly array — interně zkopíruje.
   */
  setSelection: (selectedObjectIds: readonly string[]) => void
  /**
   * Aktualizuje display name lokálního peera. Immediate (velmi nízká frekvence).
   */
  setUserName: (name: string) => void
}

// ---------------------------------------------------------------------------
// Throttle constants
// ---------------------------------------------------------------------------

/** 30 Hz = 33.33ms mezi broadcasti. */
const CURSOR_THROTTLE_MS = 33

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAwarenessUpdater(): AwarenessUpdater {
  const { awareness } = useSlideDoc()

  // Throttle state — mutable refs (žádný re-render)
  const lastEmitRef = useRef<number>(0)
  const pendingCursorRef = useRef<PeerCursor | null | undefined>(undefined) // undefined = žádný pending
  const rafHandleRef = useRef<number | null>(null)

  // Cleanup rAF při unmount
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current)
        rafHandleRef.current = null
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  const readCurrentState = useCallback((): PeerAwarenessState => {
    const raw = awareness.getLocalState() as PeerAwarenessState | null
    // Fallback pokud awareness state ještě není nastaven (edge case při mount race)
    return raw ?? { user: { id: '', name: '', color: '' }, selectedObjectIds: [], cursor: null }
  }, [awareness])

  const emitCursor = useCallback(
    (cursor: PeerCursor | null) => {
      const current = readCurrentState()
      awareness.setLocalState({ ...current, cursor })
      lastEmitRef.current = performance.now()
    },
    [awareness, readCurrentState],
  )

  const flushPendingCursor = useCallback(() => {
    rafHandleRef.current = null
    const pending = pendingCursorRef.current
    if (pending !== undefined) {
      pendingCursorRef.current = undefined
      emitCursor(pending)
    }
  }, [emitCursor])

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const setCursor = useCallback(
    (cursor: PeerCursor | null) => {
      // null (mouse leave canvas) → bypass throttle, emit immediately, cancel pending
      if (cursor === null) {
        if (rafHandleRef.current !== null) {
          cancelAnimationFrame(rafHandleRef.current)
          rafHandleRef.current = null
        }
        pendingCursorRef.current = undefined
        emitCursor(null)
        return
      }

      const now = performance.now()
      const elapsed = now - lastEmitRef.current

      if (elapsed >= CURSOR_THROTTLE_MS) {
        // Dostatečně dlouhá pauza → emit okamžitě
        pendingCursorRef.current = undefined
        if (rafHandleRef.current !== null) {
          cancelAnimationFrame(rafHandleRef.current)
          rafHandleRef.current = null
        }
        emitCursor(cursor)
      } else {
        // Příliš brzy → uložit jako pending, naplánovat rAF flush
        pendingCursorRef.current = cursor
        if (rafHandleRef.current === null) {
          rafHandleRef.current = requestAnimationFrame(flushPendingCursor)
        }
        // Aktualizujeme pending, ale nerušíme existující rAF (trailing update)
      }
    },
    [emitCursor, flushPendingCursor],
  )

  const setSelection = useCallback(
    (selectedObjectIds: readonly string[]) => {
      const current = readCurrentState()
      awareness.setLocalState({ ...current, selectedObjectIds: [...selectedObjectIds] })
    },
    [awareness, readCurrentState],
  )

  const setUserName = useCallback(
    (name: string) => {
      const current = readCurrentState()
      awareness.setLocalState({
        ...current,
        user: { ...current.user, name },
      })
    },
    [awareness, readCurrentState],
  )

  return { setCursor, setSelection, setUserName }
}
