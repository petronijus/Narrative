/**
 * state/useSlideThumbnails.ts
 *
 * React hook that produces a Map<slideId, dataUrl> of PNG thumbnails for a
 * set of slide IDs.
 *
 * Behaviour:
 * - Creates one ThumbnailRenderer on mount; destroys it on unmount.
 * - Subscribes to deck-level object changes via a SINGLE subscribeToDeckSlideEvents()
 *   observer on ctx.slides. This avoids the stale-reference bug where per-slide
 *   observers captured a Y.Array that got orphaned after a slide rebuild (e.g.
 *   Hocuspocus initial sync, moveSlide delete+recreate).
 * - Re-renders are debounced 500 ms so rapid edits do not thrash the GPU.
 * - Concurrent renderSlide() calls are automatically serialised by ThumbnailRenderer.
 * - When slideIds grows, new per-slide debouncers are added without re-creating existing ones.
 * - When slideIds shrinks, removed debouncers are cleaned up and their entries
 *   are removed from the returned Map.
 * - Slide deletion (slideId disappears from slideIds): entry removed from Map.
 * - The folder's colour tokens are an input too (renderer/colourResolver.ts):
 *   when the resolver changes — the tokens arrive after the first renders,
 *   or someone edits the palette — the slides whose token colours resolve
 *   differently are re-rendered. The first slide's thumbnail is uploaded as
 *   the deck's preview (SlidesPanel), so one rendered before the tokens
 *   arrived must not stay the last one.
 * - A failed render is retried with backoff (state/thumbnailRetry.ts): a few
 *   attempts per slide, and none while the renderer keeps failing for every
 *   slide — those wait for the next render that succeeds. Only a render
 *   rejected because this hook let its renderer go (unmount) stays silent.
 *
 * Usage:
 *   const thumbnails = useSlideThumbnails(slideIds)
 *   // thumbnails.get(slideId) === 'data:image/png;base64,...' | undefined
 */

import { useState, useEffect, useMemo, useRef, useCallback, useContext } from 'react'
import { subscribeToDeckSlideEvents } from '@narrative/slide-model'
import { yMapToPlainObject } from '@narrative/slide-model'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import { captureLiveThumbnail } from '../renderer/liveThumbnail.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { subscribeColourResolver, tokenColoursDiffer } from '../renderer/colourResolver.js'
import type { ThumbnailRenderer } from '../renderer/thumbnails.js'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { SlideObject, SlideBackground } from '@narrative/shared'
import { computeSlideNumber } from '@narrative/shared'
import { useDeckCtx } from './useDeckCtx.js'
import { decideThumbnailRetry, THUMBNAIL_RETRY_POLICY } from './thumbnailRetry.js'
import { useSlides } from './useSlides.js'
import { ActiveSlideContext } from './ActiveSlideContext.js'
import type * as Y from 'yjs'

// ---------------------------------------------------------------------------
// Cheap structural compare for SlideBackground.
// Replaces JSON.stringify(prev) === JSON.stringify(next) which ran in the
// background-watch effect on every awareness/edit tick (60 slides × 2
// stringifies × ~30 Hz). Discriminated by kind so we only compare fields
// that exist for that variant.
// ---------------------------------------------------------------------------

function backgroundsEqual(a: SlideBackground, b: SlideBackground): boolean {
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'color':
      return a.color === (b as typeof a).color && (a.alpha ?? 1) === ((b as typeof a).alpha ?? 1)
    case 'image': {
      const bb = b as typeof a
      return a.assetId === bb.assetId && a.fit === bb.fit && (a.dim ?? 0) === (bb.dim ?? 0)
    }
    case 'linearGradient': {
      const bb = b as typeof a
      return a.angleDeg === bb.angleDeg && stopsEqual(a.stops, bb.stops)
    }
    case 'radialGradient': {
      const bb = b as typeof a
      return (
        a.centerX === bb.centerX &&
        a.centerY === bb.centerY &&
        a.radius === bb.radius &&
        stopsEqual(a.stops, bb.stops)
      )
    }
  }
}

function stopsEqual(
  a: ReadonlyArray<{ offset: number; color: number; alpha?: number }>,
  b: ReadonlyArray<{ offset: number; color: number; alpha?: number }>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    if (ai.offset !== bi.offset || ai.color !== bi.color || (ai.alpha ?? 1) !== (bi.alpha ?? 1)) {
      return false
    }
  }
  return true
}

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
// Helper — read objects for a slide id from ctx by fresh traversal
// ---------------------------------------------------------------------------

function readSlideObjects(ctx: SlideMutationContext, slideId: string): SlideObject[] {
  for (let i = 0; i < ctx.slides.length; i++) {
    const slideMap = ctx.slides.get(i)
    if (slideMap.get('id') === slideId) {
      const objectsArr = slideMap.get('objects') as Y.Array<Y.Map<unknown>> | undefined
      if (objectsArr === undefined) return []
      const result: SlideObject[] = []
      for (let j = 0; j < objectsArr.length; j++) {
        try {
          result.push(yMapToPlainObject(objectsArr.get(j)))
        } catch {
          // skip malformed
        }
      }
      return result
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Debounce interval in ms — applied per slide independently. */
const DEBOUNCE_MS = 500

/** See the render queue in useSlideThumbnails. */
type RenderPriority = 'urgent' | 'background'

export interface UseSlideThumbnailsOptions {
  /** Draw the active slide from the editor's canvas (the editor's slide panel). */
  liveActiveSlide?: boolean
}

/** Thumbnail width in px — the renderer's and the live capture's. */
const THUMBNAIL_WIDTH = 200

/**
 * For a set of slide IDs, returns a Map<slideId, dataUrl> of current thumbnails.
 * Re-renders the thumbnail for a slide when that slide's objects change (debounced 500 ms).
 *
 * @param slideIds Ordered list of slide IDs to track.
 * @returns Map<string, string> — entries for slides that have been rendered at least once.
 */
export function useSlideThumbnails(
  slideIdsInput: string[],
  options: UseSlideThumbnailsOptions = {},
): Map<string, string> {
  const deckCtx = useDeckCtx()
  // The slide on the editor's canvas is drawn from that canvas (renderer/liveThumbnail.ts)
  // rather than built again in the thumbnail renderer — editor only: a presenting
  // canvas shows animation states, not the slide.
  const liveScene = useCanvasInstance()?.sceneGraph ?? null
  // Not useActiveSlide(): the presenter overlay and the tests have no provider.
  const activeSlideId = useContext(ActiveSlideContext)?.activeSlideId ?? null
  const liveSceneRef = useRef(options.liveActiveSlide === true ? liveScene : null)
  liveSceneRef.current = options.liveActiveSlide === true ? liveScene : null
  const activeSlideIdRef = useRef(activeSlideId)
  activeSlideIdRef.current = activeSlideId
  const allSlides = useSlides()
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map())

  // Stabilise the caller-provided slideIds against identity churn. Call
  // sites build this array with `slides.map(s => s.id)` inline, producing
  // a fresh reference every parent render. That ref change cascaded into
  // the deps of the effects below, retriggering `scheduleRender(id)` for
  // every tracked slide ~16 Hz while idle — each render bottoms out in
  // `gl.readPixels` (extract.base64) and the nvidia driver flags it as
  // "GPU stall due to ReadPixels", visible as steady GPU usage on an
  // otherwise idle deck. useMemo over a string key gives us a stable
  // array reference whenever the *content* is unchanged.
  const slideIdsKey = slideIdsInput.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: depend on content key, not array identity.
  const slideIds = useMemo(() => slideIdsInput, [slideIdsKey])

  // Stable ref to the renderer instance (async init, may be null briefly).
  const rendererRef = useRef<ThumbnailRenderer | null>(null)

  // Track latest objects per slide so debounced callback always uses fresh state.
  const latestObjectsRef = useRef<Map<string, SlideObject[]>>(new Map())

  // P3: track latest background per slide so thumbnails paint the same
  // artboard fill the editor shows. We re-render the thumbnail when the
  // background changes.
  const latestBackgroundRef = useRef<Map<string, SlideBackground | undefined>>(new Map())

  // Always-fresh snapshot of the deck slides for slide-number computation.
  // The render scheduler reads this through a ref so a useCallback with
  // empty deps doesn't capture a stale list across reorders.
  const slidesRef = useRef(allSlides)
  slidesRef.current = allSlides

  // Per-slide debounce cancellers — cancelled on cleanup or slide removal.
  const debouncersRef = useRef<
    Map<string, { debounced: (id: string) => void; cancel: () => void }>
  >(new Map())

  // Single deck-level unsubscribe (replaces per-slide unsubscribesRef).
  const deckUnsubRef = useRef<(() => void) | null>(null)

  // ---------------------------------------------------------------------------
  // Render helper — schedules a thumbnail update for one slide
  // ---------------------------------------------------------------------------

  // The slides this hook tracks, read by the deck callback (created once) and
  // by the render queue, which skips a slide that has gone since it was queued.
  const trackedSlideIdsRef = useRef<Set<string>>(new Set())

  /**
   * The slides waiting for a render, in two tiers. The renderer serialises
   * every render anyway (one offscreen canvas), so the hook hands it one
   * slide at a time and picks the next itself:
   *
   * - `background` — the pass that fills every thumbnail when the deck
   *   opens: on a 60-slide deck with images that is ~15 s of renders.
   * - `urgent` — everything that follows from something the user did:
   *   a slide added, duplicated or pasted, an edit, a reorder.
   *
   * Handing the renderer the whole deck at once instead (as this did) put a
   * slide duplicated right after opening the deck at the end of the
   * opening pass — its thumbnail stayed blank for as long as the pass ran.
   *
   * A slide is queued at most once (Sets keep insertion order), and a slide
   * asked for again while its render runs is re-queued once when it ends,
   * so a burst of edits costs one extra render, not one per edit.
   */
  const urgentRef = useRef<Set<string>>(new Set())
  const backgroundRef = useRef<Set<string>>(new Set())
  const inFlightRef = useRef<string | null>(null)
  const pendingDirtyRef = useRef<Map<string, RenderPriority>>(new Map())

  /**
   * Retry bookkeeping (state/thumbnailRetry.ts). `slideFailures` counts a
   * slide's failed renders since its last render request from outside (an
   * edit, a reorder, a token change — new content, new budget);
   * `consecutiveFailures` counts failures across slides since the last
   * success. A retry waits in `retryTimers`; a slide `parked` while the
   * renderer looked gone is re-queued by the next success.
   */
  const slideFailuresRef = useRef<Map<string, number>>(new Map())
  const consecutiveFailuresRef = useRef(0)
  const retryTimersRef = useRef<Map<string, number>>(new Map())
  const parkedRef = useRef<Set<string>>(new Set())

  /** Forget a slide's failures and any retry it was waiting for. */
  const clearRetry = useCallback((slideId: string): void => {
    const timer = retryTimersRef.current.get(slideId)
    if (timer !== undefined) window.clearTimeout(timer)
    retryTimersRef.current.delete(slideId)
    slideFailuresRef.current.delete(slideId)
    parkedRef.current.delete(slideId)
  }, [])

  const enqueue = useCallback((slideId: string, priority: RenderPriority): void => {
    if (inFlightRef.current === slideId) {
      // Its render already read the old state: run it once more after.
      const had = pendingDirtyRef.current.get(slideId)
      pendingDirtyRef.current.set(slideId, had === 'urgent' ? 'urgent' : priority)
      return
    }
    if (priority === 'urgent') {
      backgroundRef.current.delete(slideId)
      urgentRef.current.add(slideId)
    } else if (!urgentRef.current.has(slideId)) {
      backgroundRef.current.add(slideId)
    }
  }, [])

  /**
   * Record a failed render and decide its retry. Returns the delay before the
   * slide is rendered again, or null when it is not retried from here (parked,
   * given up, gone, or already asked for again).
   */
  const handleRenderFailure = useCallback((slideId: string, err: unknown): number | null => {
    const slideFailures = (slideFailuresRef.current.get(slideId) ?? 0) + 1
    slideFailuresRef.current.set(slideId, slideFailures)
    consecutiveFailuresRef.current += 1
    const consecutive = consecutiveFailuresRef.current
    if (slideFailures === 1) console.error('[useSlideThumbnails] renderSlide failed:', err)
    else console.warn(`[useSlideThumbnails] renderSlide failed again (${slideFailures}×):`, err)

    if (!trackedSlideIdsRef.current.has(slideId)) return null
    // Asked for again while this render ran: that render is the retry.
    if (pendingDirtyRef.current.has(slideId)) return null

    const decision = decideThumbnailRetry({ slideFailures, consecutiveFailures: consecutive })
    switch (decision.kind) {
      case 'retry':
        return decision.delayMs
      case 'park':
        if (consecutive === THUMBNAIL_RETRY_POLICY.rendererFailureLimit) {
          console.warn(
            `[useSlideThumbnails] ${consecutive} thumbnail renders failed in a row; ` +
              'retries wait until a render succeeds',
          )
        }
        parkedRef.current.add(slideId)
        return null
      case 'give-up':
        console.warn(
          `[useSlideThumbnails] giving up on the thumbnail of ${slideId} after ` +
            `${slideFailures} failed renders; the next change to the slide tries again`,
        )
        return null
    }
  }, [])

  const pump = useCallback((): void => {
    const renderer = rendererRef.current
    if (renderer === null || inFlightRef.current !== null) return

    let slideId: string | undefined
    for (const tier of [urgentRef.current, backgroundRef.current]) {
      for (const id of tier) {
        tier.delete(id)
        // Gone since it was queued (deleted, or the deck changed).
        if (!trackedSlideIdsRef.current.has(id)) continue
        slideId = id
        break
      }
      if (slideId !== undefined) break
    }
    if (slideId === undefined) return

    const objects = latestObjectsRef.current.get(slideId) ?? []
    const background = latestBackgroundRef.current.get(slideId)
    const slideNumber = computeSlideNumber(slidesRef.current, slideId)
    const surface = slidesRef.current.find((s) => s.id === slideId)?.layout?.surface
    const id = slideId
    inFlightRef.current = id

    const renderInRenderer = (): Promise<string> =>
      renderer.renderSlide(objects, background, slideNumber, surface)
    const live = liveSceneRef.current
    // The slide on the editor's canvas costs a read-back of that canvas; any slide
    // else (or a canvas that is not showing exactly this slide yet) the renderer's way.
    const rendered: Promise<string> =
      live !== null && id === activeSlideIdRef.current
        ? captureLiveThumbnail(
            live,
            objects.map((o) => o.id),
            THUMBNAIL_WIDTH,
          ).then(
            (url) => url ?? renderInRenderer(),
            () => renderInRenderer(),
          )
        : renderInRenderer()

    rendered
      .then((dataUrl) => {
        // The renderer works: whatever was parked while it did not gets
        // another go, with a fresh budget.
        slideFailuresRef.current.delete(id)
        consecutiveFailuresRef.current = 0
        for (const parked of parkedRef.current) {
          slideFailuresRef.current.delete(parked)
          enqueue(parked, 'background')
        }
        parkedRef.current.clear()
        if (!trackedSlideIdsRef.current.has(id)) return
        setThumbnails((prev) => {
          const next = new Map(prev)
          next.set(id, dataUrl)
          return next
        })
      })
      .catch((err: unknown) => {
        // This hook let the renderer go (unmount, StrictMode remount): its
        // queued renders reject with "renderer has been destroyed" — expected.
        if (rendererRef.current !== renderer) return
        const delayMs = handleRenderFailure(id, err)
        if (delayMs === null) return
        // A retry is a background render that keeps the slide's failure
        // count — unlike scheduleRender, which starts a new budget.
        const previous = retryTimersRef.current.get(id)
        if (previous !== undefined) window.clearTimeout(previous)
        retryTimersRef.current.set(
          id,
          window.setTimeout(() => {
            retryTimersRef.current.delete(id)
            if (!trackedSlideIdsRef.current.has(id)) return
            enqueue(id, 'background')
            pump()
          }, delayMs),
        )
      })
      .finally(() => {
        inFlightRef.current = null
        const again = pendingDirtyRef.current.get(id)
        if (again !== undefined) {
          pendingDirtyRef.current.delete(id)
          enqueue(id, again)
        }
        pump()
      })
  }, [enqueue, handleRenderFailure])

  const scheduleRender = useCallback(
    (slideId: string, priority: RenderPriority = 'urgent'): void => {
      // A request from outside (new content, a reorder, a token change)
      // supersedes a pending retry and starts the slide's budget over.
      clearRetry(slideId)
      enqueue(slideId, priority)
      pump()
    },
    [clearRetry, enqueue, pump],
  )

  // ---------------------------------------------------------------------------
  // Colour tokens — re-render the slides a resolver change repaints
  // ---------------------------------------------------------------------------

  // Every rendered (or queued) thumbnail resolved its token colours with the
  // resolver installed at the time; each change is handled here as it is
  // installed, so comparing the previous and the next resolution finds
  // exactly the stale ones. Urgent: a stale thumbnail shows wrong colours,
  // and the first slide's is about to become the deck's preview. A render in
  // flight is re-run after it ends (enqueue), as for an edit.
  useEffect(() => {
    return subscribeColourResolver(({ prev, next }) => {
      for (const slideId of trackedSlideIdsRef.current) {
        const objects = latestObjectsRef.current.get(slideId)
        if (objects !== undefined && tokenColoursDiffer(objects, prev, next)) {
          scheduleRender(slideId)
        }
      }
    })
  }, [scheduleRender])

  // ---------------------------------------------------------------------------
  // Ensure per-slide debouncer exists (idempotent)
  // ---------------------------------------------------------------------------

  const ensureDebouncer = useCallback(
    (slideId: string): void => {
      if (debouncersRef.current.has(slideId)) return
      const { debounced, cancel } = debounce((id: string) => {
        scheduleRender(id)
      }, DEBOUNCE_MS)
      debouncersRef.current.set(slideId, { debounced, cancel })
    },
    [scheduleRender],
  )

  const removeDebouncer = useCallback(
    (slideId: string): void => {
      const db = debouncersRef.current.get(slideId)
      db?.cancel()
      debouncersRef.current.delete(slideId)
      latestObjectsRef.current.delete(slideId)
      latestBackgroundRef.current.delete(slideId)
      clearRetry(slideId)
    },
    [clearRetry],
  )

  // ---------------------------------------------------------------------------
  // Deck-level subscription — mounted once, never torn down until unmount.
  // When a deck event fires, we fresh-traverse ctx.slides for each affected id.
  // ---------------------------------------------------------------------------

  // Keep a stable ref to deckCtx (changes are rare but possible).
  const deckCtxRef = useRef<SlideMutationContext>(deckCtx)
  useEffect(() => {
    deckCtxRef.current = deckCtx
  }, [deckCtx])

  // Mount the deck-level subscription once. We capture everything via refs.
  useEffect(() => {
    const ctx = deckCtxRef.current

    const unsub = subscribeToDeckSlideEvents(ctx, (affectedIds: Set<string>) => {
      const tracked = trackedSlideIdsRef.current
      for (const slideId of affectedIds) {
        if (!tracked.has(slideId)) continue

        // Fresh traversal — avoids stale Y.Array reference.
        const objects = readSlideObjects(deckCtxRef.current, slideId)
        latestObjectsRef.current.set(slideId, objects)

        // Also refresh the cached background from the current useSlides
        // snapshot (the deck event already fired, so slidesRef is up to
        // date by the next microtask — but here we read whatever the
        // ref has now, which is at minimum the previous snapshot; the
        // background-watch effect below converges to the latest one).
        // Without this read, background-only mutations re-render the
        // thumbnail with a stale colour from the previous render's
        // latestBackgroundRef state before the watch effect catches up.
        const slide = slidesRef.current.find((s) => s.id === slideId)
        if (slide !== undefined) {
          latestBackgroundRef.current.set(slideId, slide.background)
        }

        ensureDebouncer(slideId)
        const db = debouncersRef.current.get(slideId)
        db?.debounced(slideId)
      }
    })

    deckUnsubRef.current = unsub

    return () => {
      unsub()
      deckUnsubRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — create renderer on mount, destroy on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    // P12d: the thumbnail Pixi instance contends with the main editor
    // canvas for the GPU driver during cold start — when both initialise
    // in parallel, first-paint latency suffers. Defer this Application
    // by one frame so the editor's first paint runs first. The vitest
    // suite uses fake timers + microtask awaits and would otherwise hang
    // waiting for the deferred init, so we skip the defer in test mode.
    const isTest = import.meta.env.MODE === 'test'
    let startTimer = 0
    const start = (): void => {
      if (cancelled) return
      createThumbnailRenderer({ width: THUMBNAIL_WIDTH, resolution: 1 })
        .then((renderer) => {
          if (cancelled) {
            renderer.destroy()
            return
          }
          rendererRef.current = renderer
          // Everything asked for while the renderer was starting is queued.
          pump()
        })
        .catch((err: unknown) => {
          console.error('[useSlideThumbnails] createThumbnailRenderer failed:', err)
        })
    }
    if (isTest) {
      start()
    } else {
      startTimer = window.setTimeout(start, 0)
    }

    return () => {
      cancelled = true
      if (startTimer !== 0) window.clearTimeout(startTimer)
      rendererRef.current?.destroy()
      rendererRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally runs once on mount
  }, [])

  // ---------------------------------------------------------------------------
  // Lifecycle — track which slide ids are active; seed initial objects.
  //
  // We do NOT re-create the Yjs subscription here (that's deck-level, above).
  // Instead we just maintain debouncers + latestObjectsRef for the current
  // slideIds set, and seed initial object reads for newly appeared slides.
  // ---------------------------------------------------------------------------

  const lastSlideIdsRef = useRef<string[]>([])

  useEffect(() => {
    const prev = lastSlideIdsRef.current
    const sameOrder = prev.length === slideIds.length && prev.every((id, i) => id === slideIds[i])

    if (sameOrder) return
    // The deck opening: every slide appears at once, and the pass that
    // renders them all runs behind anything the user does meanwhile.
    const opening = prev.length === 0

    const incomingSet = new Set(slideIds)
    const prevSet = new Set(prev)

    const disappeared: string[] = []
    for (const id of prev) {
      if (!incomingSet.has(id)) disappeared.push(id)
    }
    const appeared: string[] = []
    for (const id of slideIds) {
      if (!prevSet.has(id)) appeared.push(id)
    }

    // Update the tracked set ref (used by deck callback).
    trackedSlideIdsRef.current = incomingSet

    // Clean up debouncers for slides that disappeared.
    for (const id of disappeared) {
      removeDebouncer(id)
    }

    // Seed newly appeared slides with a fresh object read + initial render.
    for (const id of appeared) {
      ensureDebouncer(id)
      const objects = readSlideObjects(deckCtx, id)
      latestObjectsRef.current.set(id, objects)
      // ALSO seed the background from the current useSlides() snapshot
      // (via slidesRef so this effect's deps don't have to include
      // `allSlides`). Without this, the initial render reads
      // `latestBackgroundRef.current.get(id) === undefined` and falls
      // through to DEFAULT_BACKGROUND (white) — visible as every
      // thumbnail flashing white on first paint, then re-painting with
      // the real background once the separate `useEffect([allSlides…])`
      // below populates the ref and fires a second scheduleRender.
      const seedSlide = slidesRef.current.find((s) => s.id === id)
      if (seedSlide !== undefined) {
        latestBackgroundRef.current.set(id, seedSlide.background)
      }
      // Schedule initial render immediately (not debounced) so thumbnails
      // appear as soon as the renderer is ready.
      scheduleRender(id, opening ? 'background' : 'urgent')
    }

    // Prune thumbnails of slides that no longer exist.
    setThumbnails((prev) => {
      let changed = false
      const next = new Map<string, string>()
      for (const [id, url] of prev) {
        if (incomingSet.has(id)) {
          next.set(id, url)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })

    lastSlideIdsRef.current = slideIds.slice()
  }, [slideIds, deckCtx, ensureDebouncer, removeDebouncer, scheduleRender])

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
      // Cheap structural compare avoids the JSON.stringify-twice hot path.
      // Backgrounds are small discriminated unions (≤ ~7 scalar fields plus
      // an optional `stops` array on gradients) so a kind-aware field check
      // is dramatically cheaper than two stringifies, especially when the
      // hook re-runs at awareness rate (~30 Hz) on a 60-slide deck.
      if (prev !== undefined && next !== undefined && backgroundsEqual(prev, next)) {
        continue
      }
      latestBackgroundRef.current.set(slide.id, next)
      scheduleRender(slide.id)
    }
  }, [allSlides, slideIds, scheduleRender])

  // Re-render every tracked thumbnail when the deck order or skipped
  // flags change, since `computeSlideNumber` reads from that list and
  // any slide may host a `isSlideNumber` text leaf whose displayed
  // number just shifted.
  // Hoist the order/skipped fingerprint so it isn't recomputed inside the
  // dep array on every render — the previous shape did a full deck traversal
  // (60 slides ≈ 60 string concats) per parent render even when nothing
  // structural changed.
  const orderFingerprint = useMemo(
    () => allSlides.map((s) => `${s.id}:${s.skipped === true ? 'x' : '_'}`).join('|'),
    [allSlides],
  )
  // Its first run with slides is the deck opening, already queued by the
  // seeding above. (Before the doc has synced the list is empty: that run
  // does not count, or the opening pass would come through as urgent.)
  const orderSeenRef = useRef(false)
  useEffect(() => {
    const priority: RenderPriority = orderSeenRef.current ? 'urgent' : 'background'
    if (slideIds.length > 0) orderSeenRef.current = true
    for (const id of slideIds) scheduleRender(id, priority)
    // Depend on a stable fingerprint string so unrelated slide-prop
    // edits (background, name) don't double-trigger here — the
    // background-watch effect above already covers those.
  }, [orderFingerprint, slideIds, scheduleRender])

  // ---------------------------------------------------------------------------
  // Cleanup all per-slide state on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // The retry bookkeeping lives for the hook's lifetime (never reassigned).
    const retryTimers = retryTimersRef.current
    const slideFailures = slideFailuresRef.current
    const parked = parkedRef.current
    return () => {
      for (const slideId of [...debouncersRef.current.keys()]) {
        removeDebouncer(slideId)
      }
      trackedSlideIdsRef.current = new Set()
      urgentRef.current.clear()
      backgroundRef.current.clear()
      pendingDirtyRef.current.clear()
      for (const timer of retryTimers.values()) window.clearTimeout(timer)
      retryTimers.clear()
      slideFailures.clear()
      parked.clear()
      consecutiveFailuresRef.current = 0
      // React 18 StrictMode persists refs across the mount→unmount→remount cycle.
      // Reset lastSlideIdsRef so remount re-seeds all slides.
      lastSlideIdsRef.current = []
      orderSeenRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, [])

  return thumbnails
}
