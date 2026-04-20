/**
 * state/useSlideObjectChanges.ts
 *
 * Hook for consuming incremental object changes from Y.Doc.
 * Intended for the renderer (surgical updates) — not for UI components.
 *
 * For UI components wanting a plain objects snapshot, use useSlideObjects().
 * For the renderer (surgical apply), use this hook with ObjectChangeSet callback.
 *
 * M9 update: scoped to active slide via ActiveSlideContext.
 * Re-subscribes when activeSlideId changes.
 */

import { useEffect, useRef } from 'react'
import { subscribeToSlideObjects } from '@narrative/slide-model'
import type { ObjectChangeSet } from '@narrative/slide-model'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

/**
 * Subscribe to incremental changes with per-frame batching.
 *
 * Callback is stored in a ref — does not cause re-subscribe on every re-render.
 * Re-subscribes only when deckCtx or activeSlideId changes.
 *
 * Initial call: callback is called synchronously in useEffect setup
 * with initial state { added: <all existing>, removed: [], updated: [], snapshot: [...] }.
 *
 * If there is no active slide, callback is never called.
 *
 * @param callback Function called on each batched change set
 */
export function useSlideObjectChanges(callback: (changes: ObjectChangeSet) => void): void {
  const { deckCtx } = useSlideDoc()
  const { activeSlideId } = useActiveSlide()

  // Callback in ref — avoid re-subscribe on every re-render
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (activeSlideId === null) return

    const unsubscribe = subscribeToSlideObjects(deckCtx, activeSlideId, (changes) =>
      callbackRef.current(changes),
    )
    return unsubscribe
  }, [deckCtx, activeSlideId])
}
