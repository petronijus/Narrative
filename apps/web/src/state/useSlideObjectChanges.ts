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

import { useEffect, useMemo, useRef } from 'react'
import { subscribeToSlideObjects } from '@narrative/slide-model'
import type { ObjectChangeSet } from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'
import { useSlides } from './useSlides.js'

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
  const slides = useSlides()

  // Callback in ref — avoid re-subscribe on every re-render
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  // Track the last snapshot of objects shown to the consumer so that when the
  // active slide changes we can emit a synthetic "remove all previous" change
  // set before subscribing to the new slide. Without this the SceneGraph would
  // retain objects from the previous slide and stack new ones on top.
  const lastSnapshotRef = useRef<SlideObject[]>([])

  // Slide order fingerprint — moveSlide() recreates the slide Y.Map (Yjs has no
  // in-place reorder) which orphans the observer attached to the old objects
  // Y.Array. When the ordered slide list changes we MUST re-subscribe to the
  // fresh Y.Map for activeSlideId. Transition/object edits don't change this
  // fingerprint so we don't re-subscribe on every edit.
  const slideOrderKey = useMemo(() => slides.map((s) => s.id).join('|'), [slides])

  useEffect(() => {
    if (activeSlideId === null) return

    // If switching slides (or remounting after reorder), first tell the consumer
    // to remove everything from the previously shown slide. The next subscribe()
    // will emit the new slide's objects via the initial synchronous emission.
    if (lastSnapshotRef.current.length > 0) {
      const prevIds = lastSnapshotRef.current.map((o) => o.id)
      callbackRef.current({ added: [], removed: prevIds, updated: [], snapshot: [] })
      lastSnapshotRef.current = []
    }

    const unsubscribe = subscribeToSlideObjects(deckCtx, activeSlideId, (changes) => {
      lastSnapshotRef.current = changes.snapshot
      callbackRef.current(changes)
    })
    return unsubscribe
  }, [deckCtx, activeSlideId, slideOrderKey])
}
