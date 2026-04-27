/**
 * state/useSlideThumbnails.ts
 *
 * React hook that produces a Map<slideId, dataUrl> of PNG thumbnails for a
 * set of slide IDs.
 *
 * Behaviour:
 * - Creates one ThumbnailRenderer on mount; destroys it on unmount.
 * - Subscribes to each slide's object changes via subscribeToSlideObjects().
 * - Re-renders are debounced 500 ms so rapid edits do not thrash the GPU.
 * - Concurrent renderSlide() calls are automatically serialised by ThumbnailRenderer.
 * - When slideIds grows, new subscriptions are added without re-creating existing ones.
 * - When slideIds shrinks, removed subscriptions are cleaned up and their entries
 *   are removed from the returned Map.
 * - Slide deletion (slideId disappears from slideIds): entry removed from Map.
 *
 * Usage:
 *   const thumbnails = useSlideThumbnails(slideIds)
 *   // thumbnails.get(slideId) === 'data:image/png;base64,...' | undefined
 *
 * Limitation:
 * - createThumbnailRenderer() is async. Thumbnails start generating after the
 *   renderer is ready (usually < 1 rAF after mount). Until then the Map is empty.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { subscribeToSlideObjects, listSlides } from '@narrative/slide-model'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import type { ThumbnailRenderer } from '../renderer/thumbnails.js'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject, SlideBackground } from '@narrative/shared'
import { useDeckCtx } from './useDeckCtx.js'
import { useSlides } from './useSlides.js'

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

/**
 * Returns a debounced version of fn that delays invocation by delayMs.
 * Each call resets the timer. The returned cancel() clears any pending call.
 */
function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): { debounced: (...args: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = (...args: T): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delayMs)
  }

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return { debounced, cancel }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Debounce interval in ms — applied per slide independently. */
const DEBOUNCE_MS = 500

/**
 * For a set of slide IDs, returns a Map<slideId, dataUrl> of current thumbnails.
 * Re-renders the thumbnail for a slide when that slide's objects change (debounced 500 ms).
 *
 * @param slideIds Ordered list of slide IDs to track.
 * @returns Map<string, string> — entries for slides that have been rendered at least once.
 */
export function useSlideThumbnails(slideIds: string[]): Map<string, string> {
  const deckCtx = useDeckCtx()
  const allSlides = useSlides()
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())

  // Stable ref to the renderer instance (async init, may be null briefly).
  const rendererRef = useRef<ThumbnailRenderer | null>(null)

  // Track latest objects per slide so debounced callback always uses fresh state.
  const latestObjectsRef = useRef<Map<string, SlideObject[]>>(new Map())

  // P3: track latest background per slide so thumbnails paint the same
  // artboard fill the editor shows. We re-render the thumbnail when the
  // background changes.
  const latestBackgroundRef = useRef<Map<string, SlideBackground | undefined>>(new Map())

  // Per-slide debounce cancellers — cancelled on cleanup or slide removal.
  const debouncersRef = useRef<
    Map<string, { debounced: (id: string) => void; cancel: () => void }>
  >(new Map())

  // Per-slide Yjs unsubscribe functions.
  const unsubscribesRef = useRef<Map<string, () => void>>(new Map())

  // ---------------------------------------------------------------------------
  // Render helper — schedules a thumbnail update for one slide
  // ---------------------------------------------------------------------------

  const scheduleRender = useCallback((slideId: string): void => {
    const renderer = rendererRef.current
    if (renderer === null) return

    const objects = latestObjectsRef.current.get(slideId) ?? []
    const background = latestBackgroundRef.current.get(slideId)

    renderer
      .renderSlide(objects, background)
      .then((dataUrl) => {
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(slideId, dataUrl)
          return next
        })
      })
      .catch((err: unknown) => {
        // Renderer destroyed between schedule and resolve — ignore.
        if (err instanceof Error && err.message.includes('renderer has been destroyed')) {
          return
        }
        console.error('[useSlideThumbnails] renderSlide failed:', err)
      })
  }, [])

  // ---------------------------------------------------------------------------
  // Subscribe / unsubscribe helpers
  // ---------------------------------------------------------------------------

  const subscribeSlide = useCallback(
    (slideId: string, ctx: SlideMutationContext): void => {
      if (unsubscribesRef.current.has(slideId)) return // already subscribed

      // Create a debouncer for this slide.
      const { debounced, cancel } = debounce((id: string) => {
        scheduleRender(id)
      }, DEBOUNCE_MS)

      debouncersRef.current.set(slideId, { debounced, cancel })

      // Seed latestObjectsRef + latestBackgroundRef from the current Y.Doc
      // snapshot. subscribeToSlideObjects ONLY fires on changes — without
      // this seed the render path reads an empty objects array and the
      // thumbnail goes blank for any slide that's re-subscribed (which
      // happens whenever slideIds changes, e.g. user adds a new slide).
      const slides = listSlides(ctx)
      const initial = slides.find((s) => s.id === slideId)
      if (initial !== undefined) {
        latestObjectsRef.current.set(slideId, initial.objects)
        latestBackgroundRef.current.set(slideId, initial.background)
        // Trigger an immediate render so the thumbnail appears without
        // waiting for the user to edit the slide.
        scheduleRender(slideId)
      }

      const unsubscribe = subscribeToSlideObjects(ctx, slideId, (changes) => {
        // Always track latest objects snapshot.
        latestObjectsRef.current.set(slideId, changes.snapshot)
        // Debounce the actual GPU render.
        debounced(slideId)
      })

      unsubscribesRef.current.set(slideId, unsubscribe)
    },
    [scheduleRender],
  )

  const unsubscribeSlide = useCallback((slideId: string): void => {
    const unsub = unsubscribesRef.current.get(slideId)
    unsub?.()
    unsubscribesRef.current.delete(slideId)

    const db = debouncersRef.current.get(slideId)
    db?.cancel()
    debouncersRef.current.delete(slideId)

    latestObjectsRef.current.delete(slideId)
    latestBackgroundRef.current.delete(slideId)
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — create renderer on mount, destroy on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    createThumbnailRenderer({ width: 200, resolution: 1 })
      .then((renderer) => {
        if (cancelled) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer

        // Trigger initial renders for all currently tracked slides.
        for (const slideId of latestObjectsRef.current.keys()) {
          scheduleRender(slideId)
        }
      })
      .catch((err: unknown) => {
        console.error('[useSlideThumbnails] createThumbnailRenderer failed:', err)
      })

    return () => {
      cancelled = true
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — subscribe/unsubscribe when slideIds list changes
  //
  // moveSlide() in slide-model deletes+recreates the slide's Y.Map (Yjs has no
  // in-place reorder for Y.Array<Y.Map>), which orphans any observer attached
  // to the old objects Y.Array. We MUST re-subscribe whenever slide order or
  // membership changes — otherwise thumbnails of reordered slides stop updating.
  //
  // We detect reorder/membership changes by comparing the ordered slideIds
  // array against the previous value. Unchanged order → skip (no-op).
  // ---------------------------------------------------------------------------

  const lastSlideIdsRef = useRef<string[]>([])

  useEffect(() => {
    const prev = lastSlideIdsRef.current
    const sameOrder = prev.length === slideIds.length && prev.every((id, i) => id === slideIds[i])

    if (sameOrder) return

    // Tear down ALL existing subscriptions — cheap relative to GPU render, and
    // correct regardless of whether Y.Map identity changed underneath.
    for (const slideId of [...unsubscribesRef.current.keys()]) {
      unsubscribeSlide(slideId)
    }

    // Subscribe fresh for current slide IDs.
    for (const slideId of slideIds) {
      subscribeSlide(slideId, deckCtx)
    }

    // Prune thumbnails of slides that no longer exist.
    const incoming = new Set(slideIds)
    setThumbnails((prev) => {
      let changed = false
      const next = new Map<string, string>()
      for (const [id, url] of prev) {
        if (incoming.has(id)) {
          next.set(id, url)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    lastSlideIdsRef.current = slideIds.slice()
  }, [slideIds, deckCtx, subscribeSlide, unsubscribeSlide])

  // ---------------------------------------------------------------------------
  // P3: watch slide backgrounds — re-render thumbnails when they change.
  // Reads from the `useSlides()` snapshot, which already re-runs whenever
  // any slide-level change lands (background, transition, name, …).
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const tracked = new Set(slideIds)
    for (const slide of allSlides) {
      if (!tracked.has(slide.id)) continue
      const prev = latestBackgroundRef.current.get(slide.id)
      const next = slide.background
      if (prev === next) continue
      // Shallow compare kind + common fields to avoid re-render thrash on
      // identical-but-fresh objects coming out of the Y.Doc binding.
      if (
        prev !== undefined &&
        next !== undefined &&
        prev.kind === next.kind &&
        JSON.stringify(prev) === JSON.stringify(next)
      ) {
        continue
      }
      latestBackgroundRef.current.set(slide.id, next)
      scheduleRender(slide.id)
    }
  }, [allSlides, slideIds, scheduleRender])

  // ---------------------------------------------------------------------------
  // Cleanup all subscriptions on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      for (const slideId of [...unsubscribesRef.current.keys()]) {
        unsubscribeSlide(slideId)
      }
      // React 18 StrictMode persists refs across the mount→unmount→remount cycle.
      // If we don't reset lastSlideIdsRef here, the remount's slideIds effect
      // sees sameOrder=true and skips resubscribing — leaving latestObjectsRef
      // empty forever. Clear it so remount sees a fresh baseline.
      lastSlideIdsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, [])

  return thumbnails
}
