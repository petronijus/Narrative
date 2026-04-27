/**
 * state/ActiveSlideContext.tsx
 *
 * Ephemeral per-client active slide state (M9).
 *
 * Per BUILD_PLAN M9: active slide is NOT in Y.Doc — it is local React state.
 * Each client independently tracks which slide they are viewing/editing.
 * This is distinct from Yjs awareness (cursor/selection) — not broadcast to peers.
 *
 * Provider:
 * - Reads slide list from Y.Doc via subscribeToSlides.
 * - Defaults to first slide when Y.Doc is ready.
 * - Auto-corrects: if activeSlideId points to a deleted slide (remote edit),
 *   resets to the first available slide.
 *
 * Place: wraps content inside SlideDocProvider (i.e. inside DeckShell).
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { subscribeToSlides } from '@narrative/slide-model'
import type { SlideSummary } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface ActiveSlideContextValue {
  /** ID of the currently active slide, or null before Y.Doc is ready. */
  activeSlideId: string | null
  /** Set the active slide by ID. No-op if ID not in current slide list. */
  setActiveSlideId: (id: string) => void
}

export const ActiveSlideContext = createContext<ActiveSlideContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface ActiveSlideProviderProps {
  children: React.ReactNode
}

export function ActiveSlideProvider({ children }: ActiveSlideProviderProps) {
  const { deckCtx } = useSlideDoc()
  const [slides, setSlides] = useState<SlideSummary[]>([])
  const [activeSlideId, setActiveSlideIdState] = useState<string | null>(null)

  // Subscribe to slide list changes
  useEffect(() => {
    const unsubscribe = subscribeToSlides(deckCtx, (newSlides) => {
      setSlides(newSlides)

      // Default to first slide when list becomes available
      setActiveSlideIdState((prev) => {
        if (prev === null && newSlides.length > 0) {
          return newSlides[0]?.id ?? null
        }
        // Auto-correction: if current slide was deleted, reset to first
        const stillExists = newSlides.some((s) => s.id === prev)
        if (!stillExists && newSlides.length > 0) {
          return newSlides[0]?.id ?? null
        }
        return prev
      })
    })
    return unsubscribe
  }, [deckCtx])

  const setActiveSlideId = useCallback(
    (id: string) => {
      if (slides.some((s) => s.id === id)) {
        setActiveSlideIdState(id)
      }
    },
    [slides],
  )

  return (
    <ActiveSlideContext.Provider value={{ activeSlideId, setActiveSlideId }}>
      {children}
    </ActiveSlideContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useActiveSlide(): ActiveSlideContextValue {
  const ctx = useContext(ActiveSlideContext)
  if (ctx === null) {
    throw new Error('useActiveSlide must be used within ActiveSlideProvider')
  }
  return ctx
}
