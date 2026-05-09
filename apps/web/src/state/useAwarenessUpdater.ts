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

import { useCallback, useMemo, useRef, useEffect } from 'react'
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

  // Throttle state — mutable refs (žádný re-render).
  // Use setTimeout (not rAF) for the trailing flush so we wait the *exact*
  // remaining slice of the 33 ms window instead of flushing on the next
  // frame (~16 ms). Without this the effective rate doubles to ~60 Hz.
  const lastEmitRef = useRef<number>(0)
  const pendingCursorRef = useRef<PeerCursor | null | undefined>(undefined) // undefined = žádný pending
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cleanup pending timer při unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
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
    flushTimerRef.current = null
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
        if (flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current)
          flushTimerRef.current = null
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
        if (flushTimerRef.current !== null) {
          clearTimeout(flushTimerRef.current)
          flushTimerRef.current = null
        }
        emitCursor(cursor)
      } else {
        // Příliš brzy → uložit jako pending, naplánovat trailing flush za
        // přesný zbývající čas (lastEmit + 33 ms - now). Předchozí varianta
        // používala requestAnimationFrame, které vystřelí na nejbližším
        // frame (~16 ms) a efektivní rate vyskočí na ~60 Hz.
        pendingCursorRef.current = cursor
        if (flushTimerRef.current === null) {
          const remaining = Math.max(0, CURSOR_THROTTLE_MS - elapsed)
          flushTimerRef.current = setTimeout(flushPendingCursor, remaining)
        }
        // Aktualizujeme pending, ale nerušíme existující timer (trailing update)
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

  // Memoize the returned object so the AwarenessUpdater reference is stable
  // across re-renders. Without this, any consumer that uses the returned
  // value as a useEffect dependency re-runs on every render of this hook's
  // owner (EditorLayout passes setSelection into a useEffect dep array).
  return useMemo(
    () => ({ setCursor, setSelection, setUserName }),
    [setCursor, setSelection, setUserName],
  )
}
