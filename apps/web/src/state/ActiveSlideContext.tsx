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
 * - Accepts a slide the document has but this provider's (rAF-coalesced)
 *   snapshot has not caught up with yet — see `setActiveSlideId`.
 *
 * Place: wraps content inside SlideDocProvider (i.e. inside DeckShell).
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { listSlides, subscribeToSlides } from '@narrative/slide-model'
import type { SlideSummary } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'

// Persist active slide per deck across reloads. Ephemeral per-client UI state,
// so localStorage (not Y.Doc / awareness) is the right home.
const STORAGE_KEY_PREFIX = 'narrative.activeSlideId.'

function readStoredSlideId(deckId: string | undefined): string | null {
  if (deckId === undefined || deckId === '') return null
  try {
    return window.localStorage.getItem(STORAGE_KEY_PREFIX + deckId)
  } catch {
    return null
  }
}

function writeStoredSlideId(deckId: string | undefined, slideId: string | null): void {
  if (deckId === undefined || deckId === '') return
  try {
    if (slideId === null) {
      window.localStorage.removeItem(STORAGE_KEY_PREFIX + deckId)
    } else {
      window.localStorage.setItem(STORAGE_KEY_PREFIX + deckId, slideId)
    }
  } catch {
    // ignore storage errors (quota, private mode)
  }
}

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
  const { id: deckId } = useParams<{ id: string }>()
  const [slides, setSlides] = useState<SlideSummary[]>([])
  const [activeSlideId, setActiveSlideIdState] = useState<string | null>(null)

  // Subscribe to slide list changes
  useEffect(() => {
    const unsubscribe = subscribeToSlides(deckCtx, (newSlides) => {
      setSlides(newSlides)

      setActiveSlideIdState((prev) => {
        // First resolution after load: prefer persisted slide if it still exists.
        if (prev === null && newSlides.length > 0) {
          const stored = readStoredSlideId(deckId)
          if (stored !== null && newSlides.some((s) => s.id === stored)) {
            return stored
          }
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
  }, [deckCtx, deckId])

  // Persist active slide whenever it changes
  useEffect(() => {
    if (activeSlideId !== null) {
      writeStoredSlideId(deckId, activeSlideId)
    }
  }, [deckId, activeSlideId])

  const setActiveSlideId = useCallback(
    (id: string) => {
      // The guard exists to ignore an id that no longer exists — a stale
      // click on a slide a peer has just deleted. But `slides` is this
      // provider's own state, fed by an rAF-coalesced subscription, so it
      // lags the document by up to a frame and is simply empty for the first
      // moments after a deck opens.
      //
      // Checking only that snapshot meant a click arriving in that window was
      // dropped in silence, leaving activeSlideId null — whereupon the next
      // subscription callback took the `prev === null` first-resolution
      // branch and selected the FIRST slide. Clicking a thumbnail right after
      // opening a deck would snap back to slide 1, and the slides panel would
      // collapse its selection to match.
      //
      // So fall back to the live document, which is never stale.
      if (slides.some((s) => s.id === id) || listSlides(deckCtx).some((s) => s.id === id)) {
        setActiveSlideIdState(id)
      }
    },
    [slides, deckCtx],
  )

  return (
    <ActiveSlideContext value={{ activeSlideId, setActiveSlideId }}>{children}</ActiveSlideContext>
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
