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
 * - Reads the slide ids from the deck's shared store (useDeckStore.ts) — only
 *   the ids: an edit inside a slide does not re-render the provider, and the
 *   context value changes only when the active slide does (every editor
 *   component reads this context; performance.md → E1).
 * - Defaults to first slide when Y.Doc is ready.
 * - Auto-corrects: if activeSlideId points to a deleted slide (remote edit),
 *   resets to the first available slide.
 * - Accepts a slide the document has but this provider's render has not
 *   caught up with yet — see `setActiveSlideId`.
 *
 * Place: wraps content inside SlideDocProvider (i.e. inside DeckShell).
 */

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { SLIDE_IDS_KEY_SEPARATOR, useDeckStore, useSlideIdsKey } from './useDeckStore.js'

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
  const store = useDeckStore()
  const { id: deckId } = useParams<{ id: string }>()
  const slideIdsKey = useSlideIdsKey()
  const [activeSlideId, setActiveSlideIdState] = useState<string | null>(null)

  // Resolve the active slide whenever the slide list changes.
  useEffect(() => {
    const ids = slideIdsKey === '' ? [] : slideIdsKey.split(SLIDE_IDS_KEY_SEPARATOR)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the slide list is an external store; this resolves the active slide against each new list (it used to run in the store subscription's callback)
    setActiveSlideIdState((prev) => {
      // First resolution after load: prefer persisted slide if it still exists.
      if (prev === null && ids.length > 0) {
        const stored = readStoredSlideId(deckId)
        if (stored !== null && ids.includes(stored)) {
          return stored
        }
        return ids[0] ?? null
      }
      // Auto-correction: if current slide was deleted, reset to first
      const stillExists = prev !== null && ids.includes(prev)
      if (!stillExists && ids.length > 0) {
        return ids[0] ?? null
      }
      return prev
    })
  }, [slideIdsKey, deckId])

  // Persist active slide whenever it changes
  useEffect(() => {
    if (activeSlideId !== null) {
      writeStoredSlideId(deckId, activeSlideId)
    }
  }, [deckId, activeSlideId])

  const setActiveSlideId = useCallback(
    (id: string) => {
      // The guard exists to ignore an id that no longer exists — a stale
      // click on a slide a peer has just deleted. It reads the store, which
      // is current at the moment of the call (it rebuilds from the document
      // on read), never this provider's last render: right after a deck
      // opens that render can still be empty, and a click dropped there left
      // activeSlideId null — whereupon the first-resolution branch above
      // selected the FIRST slide, snapping a thumbnail click back to slide 1.
      if (store.getSlide(id) !== undefined) {
        setActiveSlideIdState(id)
      }
    },
    [store],
  )

  const value = useMemo(
    () => ({ activeSlideId, setActiveSlideId }),
    [activeSlideId, setActiveSlideId],
  )

  return <ActiveSlideContext value={value}>{children}</ActiveSlideContext>
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
