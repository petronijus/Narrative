/**
 * state/useSlideThumbnails.ts
 *
 * The React side of the slide thumbnails: feeds a ThumbnailStore
 * (renderer/thumbnailStore.ts — what is rendered when, keyed by content,
 * visible first, the rest at idle) with the deck's slides and hands out the
 * pictures as object URLs.
 *
 * - One ThumbnailRenderer (an offscreen Pixi app) per hook, created a frame
 *   after mount so the editor's first paint goes first; destroyed on unmount.
 * - A SINGLE subscribeToDeckSlideEvents() observer on ctx.slides: objects are
 *   read by fresh traversal for the affected slides (a per-slide observer
 *   captured a Y.Array orphaned by a slide rebuild — the initial sync,
 *   moveSlide's delete + recreate). An edit's render waits for the store's
 *   debounce, and for the end of a pointer gesture.
 * - Background, surface and slide number come from the useSlides()
 *   snapshot; a slide whose key does not change by them (every slide without
 *   a slide-number leaf, on a reorder) is not rendered again.
 * - The folder's colour tokens and the deck's font faces are inputs too
 *   (renderer/colourResolver.ts, renderer/fontChanges.ts): when either
 *   changes, every key is worked out again and the slides whose picture
 *   changed are rendered at idle.
 * - With `liveActiveSlide`, the slide on the editor's canvas is drawn from
 *   that canvas (renderer/liveThumbnail.ts).
 *
 * Usage:
 *   const store = useSlideThumbnailStore(slideIds, { liveActiveSlide: true })
 *   const url = useThumbnailUrl(store, slideId)   // one row: re-renders with its picture only
 *   const thumbnails = useSlideThumbnails(slideIds) // Map<slideId, objectUrl>
 */

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { subscribeToDeckSlideEvents, yMapToPlainObject } from '@narrative/slide-model'
import type { SlideMutationContext } from '@narrative/slide-model'
import type { Slide, SlideObject, SlideBackground } from '@narrative/shared'
import { computeSlideNumber } from '@narrative/shared'
import type * as Y from 'yjs'
import { createThumbnailRenderer } from '../renderer/thumbnails.js'
import { captureLiveThumbnail } from '../renderer/liveThumbnail.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { subscribeColourResolver, tokenColourSignature } from '../renderer/colourResolver.js'
import { fontFamilyVersions, subscribeFontFamilyChanges } from '../renderer/fontChanges.js'
import { createThumbnailUrl, revokeThumbnailUrl } from '../renderer/thumbnailImages.js'
import { ThumbnailStore } from '../renderer/thumbnailStore.js'
import type { ThumbnailInputs } from '../renderer/thumbnailKey.js'
import { useDeckCtx } from './useDeckCtx.js'
import { useSlides } from './useSlides.js'
import { ActiveSlideContext } from './ActiveSlideContext.js'

// ---------------------------------------------------------------------------
// Cheap structural compare for SlideBackground (the useSlides snapshot is a
// fresh copy on every change: compare values, not references).
// ---------------------------------------------------------------------------

function backgroundsEqual(a: SlideBackground | undefined, b: SlideBackground | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
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
// Reading a slide's objects from the document
// ---------------------------------------------------------------------------

function readObjects(slideMap: Y.Map<unknown> | undefined): SlideObject[] {
  const objectsArr = slideMap?.get('objects') as Y.Array<Y.Map<unknown>> | undefined
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

/** The slides of the deck by id (one pass, for many reads). */
function slideMapsById(ctx: SlideMutationContext): Map<string, Y.Map<unknown>> {
  const out = new Map<string, Y.Map<unknown>>()
  for (let i = 0; i < ctx.slides.length; i++) {
    const slideMap = ctx.slides.get(i)
    out.set(slideMap.get('id') as string, slideMap)
  }
  return out
}

// ---------------------------------------------------------------------------
// Pointer gestures
// ---------------------------------------------------------------------------

/**
 * A pointer held down and moving: renders of edits wait for its end. A
 * pointer held still for this long counts as ended (rendering then costs the
 * gesture nothing, and a lost pointerup cannot hold thumbnails forever).
 */
const GESTURE_IDLE_MS = 2_000

function watchPointerGestures(onChange: (active: boolean) => void): () => void {
  let active = false
  let timer = 0
  const set = (next: boolean): void => {
    window.clearTimeout(timer)
    if (next) timer = window.setTimeout(() => set(false), GESTURE_IDLE_MS)
    if (active === next) return
    active = next
    onChange(next)
  }
  const down = (): void => set(true)
  const move = (e: PointerEvent): void => {
    if (e.buttons !== 0) set(true)
  }
  const up = (): void => set(false)
  const opts = { capture: true, passive: true } as const
  window.addEventListener('pointerdown', down, opts)
  window.addEventListener('pointermove', move, opts)
  window.addEventListener('pointerup', up, opts)
  window.addEventListener('pointercancel', up, opts)
  window.addEventListener('blur', up)
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('pointerdown', down, opts)
    window.removeEventListener('pointermove', move, opts)
    window.removeEventListener('pointerup', up, opts)
    window.removeEventListener('pointercancel', up, opts)
    window.removeEventListener('blur', up)
    if (active) onChange(false)
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface UseSlideThumbnailsOptions {
  /** Draw the active slide from the editor's canvas (the editor's slide panel). */
  liveActiveSlide?: boolean
}

/** Thumbnail width in px — the renderer's and the live capture's. */
const THUMBNAIL_WIDTH = 200

interface SlideSnapshot {
  background: SlideBackground | undefined
  surface: string | undefined
  slideNumber: number | undefined
}

/** A slide's snapshot-side inputs, from a useSlides() list. */
function snapshotOf(slides: readonly Slide[], slideId: string): SlideSnapshot {
  const slide = slides.find((s) => s.id === slideId)
  return {
    background: slide?.background,
    surface: slide?.layout?.surface,
    slideNumber: computeSlideNumber(slides, slideId),
  }
}

/**
 * The thumbnail store of a set of slides (ordered ids), kept current with
 * the deck. Read it with useThumbnailUrl (one slide) or useSlideThumbnails.
 */
export function useSlideThumbnailStore(
  slideIdsInput: string[],
  options: UseSlideThumbnailsOptions = {},
): ThumbnailStore {
  const deckCtx = useDeckCtx()
  // Not useActiveSlide(): the presenter overlay and the tests have no provider.
  const activeSlideId = useContext(ActiveSlideContext)?.activeSlideId ?? null
  const canvasScene = useCanvasInstance()?.sceneGraph ?? null
  const liveScene = options.liveActiveSlide === true ? canvasScene : null
  const allSlides = useSlides()

  // The latest values, for the store's callbacks and the observers registered once.
  const activeSlideIdRef = useRef(activeSlideId)
  const deckCtxRef = useRef<SlideMutationContext>(deckCtx)
  const slidesRef = useRef(allSlides)
  useLayoutEffect(() => {
    activeSlideIdRef.current = activeSlideId
    deckCtxRef.current = deckCtx
    slidesRef.current = allSlides
  })

  // Call sites build the id list inline (`slides.map(s => s.id)`): depend on
  // its content, not its identity, or every parent render re-seeds.
  const slideIdsKey = slideIdsInput.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: depend on content key, not array identity.
  const slideIds = useMemo(() => slideIdsInput, [slideIdsKey])

  const [store] = useState(
    () =>
      new ThumbnailStore({
        env: { tokenColours: tokenColourSignature, fontVersions: fontFamilyVersions },
        urls: { create: createThumbnailUrl, revoke: revokeThumbnailUrl },
      }),
  )

  // The active slide from the editor's canvas, while there is one to read.
  useEffect(() => {
    if (liveScene === null) {
      store.setLiveCapture(null)
      return
    }
    store.setLiveCapture((slideId, inputs) =>
      slideId === activeSlideIdRef.current
        ? captureLiveThumbnail(
            liveScene,
            inputs.objects.map((o) => o.id),
            THUMBNAIL_WIDTH,
          )
        : null,
    )
    return () => store.setLiveCapture(null)
  }, [store, liveScene])

  // What the hook knows about each slide, for its lifetime (never reassigned).
  const [known] = useState(() => ({
    /** The tracked slides: the deck callback skips any other. */
    tracked: new Set<string>(),
    /** Each tracked slide's latest objects, read from the document. */
    objects: new Map<string, SlideObject[]>(),
    /** What the useSlides snapshot said about each slide when last fed to the store. */
    seen: new Map<string, SlideSnapshot>(),
  }))
  const lastSlideIdsRef = useRef<string[]>([])

  /** A slide's inputs: its objects as last read, the rest from `snapshot`. */
  const inputsOf = (slideId: string, snapshot: SlideSnapshot): ThumbnailInputs => ({
    objects: known.objects.get(slideId) ?? [],
    ...snapshot,
  })

  // Lifecycle: the store lives as long as the hook (StrictMode remounts restart it).
  useEffect(() => {
    store.start()
    return () => {
      store.stop()
      known.tracked.clear()
      known.objects.clear()
      known.seen.clear()
      // Re-seed every slide on a remount.
      lastSlideIdsRef.current = []
    }
  }, [store, known])

  // The offscreen renderer, a frame after mount: it contends with the editor
  // canvas for the GPU driver during cold start (P12d). The unit suite's fake
  // timers would hang on the deferral, so tests start it at once.
  useEffect(() => {
    let cancelled = false
    let renderer: Awaited<ReturnType<typeof createThumbnailRenderer>> | null = null
    const start = (): void => {
      if (cancelled) return
      createThumbnailRenderer({ width: THUMBNAIL_WIDTH, resolution: 1 })
        .then((created) => {
          if (cancelled) {
            created.destroy()
            return
          }
          renderer = created
          store.setRenderer((inputs) =>
            created.renderSlide(
              [...inputs.objects],
              inputs.background,
              inputs.slideNumber,
              inputs.surface,
            ),
          )
        })
        .catch((err: unknown) => {
          console.error('[useSlideThumbnails] createThumbnailRenderer failed:', err)
        })
    }
    const startTimer = import.meta.env.MODE === 'test' ? (start(), 0) : window.setTimeout(start, 0)
    return () => {
      cancelled = true
      if (startTimer !== 0) window.clearTimeout(startTimer)
      store.setRenderer(null)
      renderer?.destroy()
    }
  }, [store])

  // Edits: one deck-level observer; the affected slides' objects read afresh.
  useEffect(() => {
    return subscribeToDeckSlideEvents(deckCtxRef.current, (affectedIds) => {
      const maps = slideMapsById(deckCtxRef.current)
      for (const slideId of affectedIds) {
        if (!known.tracked.has(slideId)) continue
        const objects = readObjects(maps.get(slideId))
        known.objects.set(slideId, objects)
        const snapshot = known.seen.get(slideId) ?? snapshotOf(slidesRef.current, slideId)
        store.setSlide(slideId, { objects, ...snapshot }, { request: 'urgent', debounce: true })
      }
    })
  }, [store, known])

  // Tokens and fonts: every key again; what changed renders at idle.
  useEffect(() => {
    const unsubColours = subscribeColourResolver(() => store.refreshKeys())
    const unsubFonts = subscribeFontFamilyChanges(() => store.refreshKeys())
    return () => {
      unsubColours()
      unsubFonts()
    }
  }, [store])

  // Edits wait for the end of a pointer gesture.
  useEffect(() => watchPointerGestures((active) => store.setGestureActive(active)), [store])

  // The tracked slides: new ones seeded (the opening pass at idle, a slide
  // added later at once), gone ones released.
  useEffect(() => {
    const prev = lastSlideIdsRef.current
    if (prev.length === slideIds.length && prev.every((id, i) => id === slideIds[i])) return
    const opening = prev.length === 0
    const prevSet = new Set(prev)
    known.tracked.clear()
    for (const id of slideIds) known.tracked.add(id)
    store.retain(slideIds)
    for (const id of prevSet) {
      if (known.tracked.has(id)) continue
      known.objects.delete(id)
      known.seen.delete(id)
    }
    const appeared = slideIds.filter((id) => !prevSet.has(id))
    if (appeared.length > 0) {
      const maps = slideMapsById(deckCtx)
      for (const id of appeared) {
        const objects = readObjects(maps.get(id))
        known.objects.set(id, objects)
        const snapshot = snapshotOf(allSlides, id)
        known.seen.set(id, snapshot)
        store.setSlide(id, { objects, ...snapshot }, { request: opening ? 'idle' : 'urgent' })
      }
    }
    lastSlideIdsRef.current = slideIds.slice()
    // `allSlides` is read for the seed only: its changes are the next effect's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIds, deckCtx, store, known])

  // Background, surface, slide number: from the snapshot, only where they changed.
  useEffect(() => {
    for (const id of known.tracked) {
      const seen = known.seen.get(id)
      if (seen === undefined) continue
      const next = snapshotOf(allSlides, id)
      const look =
        !backgroundsEqual(seen.background, next.background) || seen.surface !== next.surface
      if (!look && seen.slideNumber === next.slideNumber) continue
      known.seen.set(id, next)
      // A background dragged through colours is an edit (debounced); a new
      // slide number is not.
      store.setSlide(id, inputsOf(id, next), { request: 'urgent', debounce: look })
    }
    // inputsOf reads `known` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSlides, store, known])

  return store
}

/** One slide's thumbnail URL; the component re-renders only when that picture changes. */
export function useThumbnailUrl(
  store: ThumbnailStore,
  slideId: string | undefined,
): string | undefined {
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => (slideId === undefined ? undefined : store.get(slideId)),
  )
}

/**
 * For a set of slide IDs, a Map<slideId, objectUrl> of their current
 * thumbnails (only the slides rendered at least once). For a few slides (the
 * presenter's next slide, a component master); a panel of many rows reads
 * each row with useThumbnailUrl instead.
 */
export function useSlideThumbnails(
  slideIds: string[],
  options: UseSlideThumbnailsOptions = {},
): ReadonlyMap<string, string> {
  const store = useSlideThumbnailStore(slideIds, options)
  return useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.snapshot(),
  )
}
