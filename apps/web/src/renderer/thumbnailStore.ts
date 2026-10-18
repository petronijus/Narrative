/**
 * renderer/thumbnailStore.ts — which slide thumbnails to render, when, and
 * which picture each slide shows (performance.md → B2).
 *
 * The thumbnails of a deck used to be re-rendered whenever anything might
 * have changed them: dragging one slide to a new place or adding one in a
 * 100-slide deck rendered ~105 thumbnails offscreen (~630 text rasters,
 * ~155 Mpx of texture uploads, the editor busy 8.8–14.4 s), and opening the
 * deck rendered all 100 in list order, each result re-rendering the whole
 * slide panel. This store renders a thumbnail only when its picture is new:
 *
 *   - **Keyed by content.** Every slide's inputs reduce to a key
 *     (renderer/thumbnailKey.ts: objects, background, surface, the token
 *     colours and font faces they use, the slide number only for a slide
 *     that shows it). A slide whose key did not change is not rendered; a
 *     key whose picture is still cached (an undo, a duplicate, a slide moved
 *     and recreated) is shown without rendering. Pictures no slide shows stay
 *     in a small LRU (`cacheSize`) before their object URLs are revoked.
 *   - **Visible first, the rest at idle.** Three tiers: `urgent` (what the
 *     user just did: an edit, a new slide), then slides in view, then — one
 *     per idle callback — everything else (the opening pass, slides that
 *     scrolled out of view, a token or font change).
 *   - **Edits debounced to the end of a gesture.** An edit waits
 *     `debounceMs` after the last change, and never fires while a pointer
 *     gesture is in progress (`setGestureActive`): a drag whose moves take
 *     more than the debounce each (a busy machine) used to render ~71
 *     thumbnails for 90 moves.
 *   - **The live slide never falls back per change.** The slide the editor
 *     shows is drawn from the editor's canvas (`live`, ~1 ms). When that
 *     scene does not settle in time and the slide already has a picture, the
 *     picture stays and the capture is tried again at idle; only after
 *     `LIVE_ATTEMPTS` misses for the same content is it rendered offscreen
 *     (one render, not one per nudge — a nudge on a slow GPU cost 121 text
 *     rasters and 4.3 s of long tasks).
 *   - **Blobs, not base64.** A render returns a PNG blob (encoded
 *     asynchronously); the store hands out object URLs
 *     (renderer/thumbnailImages.ts) and notifies per slide, so a row of the
 *     panel re-renders when its own picture changes (`subscribe`).
 *
 * A failed render is retried with backoff (state/thumbnailRetry.ts): a few
 * attempts per slide (the budget starts over with new content), none while
 * the renderer keeps failing for every slide — those wait for the next
 * render that succeeds.
 *
 * Framework-free: the React side (state/useSlideThumbnails.ts) feeds it the
 * slides and reads the URLs; the unit tests drive it with a fake clock.
 */

import { perfCount } from '@narrative/shared'
import { decideThumbnailRetry, THUMBNAIL_RETRY_POLICY } from '../state/thumbnailRetry.js'
import {
  serialiseThumbnailInputs,
  thumbnailKeyOf,
  type ThumbnailEnvironment,
  type ThumbnailInputs,
} from './thumbnailKey.js'

/** How a change asks for its render. */
export type ThumbnailRequest =
  /** Something the user did: rendered next (after the debounce, for an edit). */
  | 'urgent'
  /** Rendered when it can: in view first, the rest one per idle callback. */
  | 'idle'

export interface ThumbnailClock {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
  /** Run `fn` when the page is idle, at the latest after `timeoutMs`. */
  requestIdle(fn: () => void, timeoutMs: number): number
  cancelIdle(handle: number): void
}

export interface ThumbnailStoreOptions {
  /** The page-wide inputs of a key (colour tokens, font faces). */
  env: ThumbnailEnvironment
  /** Object URLs for the rendered pictures, and their release. */
  urls: { create(blob: Blob): string; revoke(url: string): void }
  clock?: ThumbnailClock
  /** Delay of an edit's render after its last change. */
  debounceMs?: number
  /** Pictures kept after no slide shows them any more. */
  cacheSize?: number
}

/**
 * The slide from the editor's canvas, or null when the canvas does not show
 * `slideId` (then the slide is rendered offscreen). The promise resolves to
 * null when the scene did not settle in time.
 */
export type LiveCaptureFn = (
  slideId: string,
  inputs: ThumbnailInputs,
) => Promise<Blob | null> | null

/** The offscreen renderer (renderer/thumbnails.ts → renderSlide), or null while it starts. */
export type ThumbnailRenderFn = (inputs: ThumbnailInputs) => Promise<Blob>

/** Error message of a render rejected because its renderer was destroyed (expected on unmount). */
const DESTROYED = 'renderer has been destroyed'
const DEBOUNCE_MS = 500
const CACHE_SIZE = 48
/** Live captures of one content before it is rendered offscreen instead. */
export const LIVE_ATTEMPTS = 3
/** Delay before a live capture that did not settle is tried again. */
const LIVE_RETRY_MS = 1_000
/** An idle render runs at the latest this long after it was asked for. */
const IDLE_TIMEOUT_MS = 2_000

interface SlideState {
  inputs: ThumbnailInputs
  /** `inputs` serialised (renderer/thumbnailKey.ts), kept while its parts are the same. */
  serialised: string
  /** The key of the slide's current content. */
  key: string
  /** The key of the picture the slide shows (may lag behind `key`). */
  shown: string | undefined
  /** Failed renders since the content last changed from outside. */
  failures: number
  /** Live captures of `key` that did not settle. */
  liveMisses: number
}

interface Picture {
  url: string
  /** Slides showing it. */
  refs: number
}

const browserClock: ThumbnailClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  requestIdle: (fn, timeoutMs) =>
    typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(() => fn(), { timeout: timeoutMs })
      : // Safari has no requestIdleCallback: a frame later, after the input and paint.
        window.setTimeout(fn, 16),
  cancelIdle: (h) => {
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(h)
    else window.clearTimeout(h)
  },
}

/** Are the document parts of two inputs the same values (objects by identity)? */
function sameDocumentInputs(a: ThumbnailInputs, b: ThumbnailInputs): boolean {
  if (a.objects !== b.objects || a.surface !== b.surface) return false
  if (a.background === b.background) return true
  return JSON.stringify(a.background ?? null) === JSON.stringify(b.background ?? null)
}

/** Every live store, for the perf harness's settle (`pendingThumbnailWork`). */
const liveStores = new Set<ThumbnailStore>()

/** Thumbnails waiting or rendering on this page (the perf harness waits for 0). */
export function pendingThumbnailWork(): number {
  let n = 0
  for (const store of liveStores) n += store.pendingWork()
  return n
}

export class ThumbnailStore {
  private readonly env: ThumbnailEnvironment
  private readonly urls: ThumbnailStoreOptions['urls']
  private readonly clock: ThumbnailClock
  private live: LiveCaptureFn | null = null
  private readonly debounceMs: number
  private readonly cacheSize: number

  private render: ThumbnailRenderFn | null = null
  private readonly slides = new Map<string, SlideState>()
  /** Rendered pictures by key; `unused` orders the ones no slide shows, oldest first. */
  private readonly pictures = new Map<string, Picture>()
  private readonly unused = new Set<string>()

  private readonly urgent = new Set<string>()
  private readonly idle = new Set<string>()
  /** Slides in view; null = not known (everything counts as in view). */
  private visible: ReadonlySet<string> | null = null
  private readonly debounces = new Map<string, number>()
  /** Edits whose debounce ended during a gesture: queued when it ends. */
  private readonly held = new Set<string>()
  private gesture = false
  private readonly retries = new Map<string, number>()
  private readonly parked = new Set<string>()
  private consecutiveFailures = 0

  private inFlight: { slideId: string; key: string } | null = null
  private idleHandle: number | null = null
  private idleGranted = false
  /** Until start() and after stop(): nothing is kept or rendered. */
  private stopped = true
  /** Bumped by stop(): a render started before it is ignored when it ends. */
  private generation = 0

  private readonly listeners = new Set<() => void>()
  private version = 0
  private snapshotCache: { version: number; map: ReadonlyMap<string, string> } | null = null

  constructor(options: ThumbnailStoreOptions) {
    this.env = options.env
    this.urls = options.urls
    this.clock = options.clock ?? browserClock
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.cacheSize = options.cacheSize ?? CACHE_SIZE
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The picture `slideId` shows (an object URL), if it has one. */
  get(slideId: string): string | undefined {
    const shown = this.slides.get(slideId)?.shown
    return shown === undefined ? undefined : this.pictures.get(shown)?.url
  }

  /** Every slide's picture; the same Map until something changes. */
  snapshot(): ReadonlyMap<string, string> {
    if (this.snapshotCache?.version === this.version) return this.snapshotCache.map
    const map = new Map<string, string>()
    for (const id of this.slides.keys()) {
      const url = this.get(id)
      if (url !== undefined) map.set(id, url)
    }
    this.snapshotCache = { version: this.version, map }
    return map
  }

  /** Be told whenever a slide's picture changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Renders waiting, debouncing, held for a gesture, waiting to retry or running. */
  pendingWork(): number {
    return (
      this.urgent.size +
      this.idle.size +
      this.debounces.size +
      this.held.size +
      this.retries.size +
      (this.inFlight !== null ? 1 : 0)
    )
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Draw the slides `live` returns a capture for from the editor's canvas (null: none). */
  setLiveCapture(live: LiveCaptureFn | null): void {
    this.live = live
  }

  /** The offscreen renderer is ready (or gone: null). */
  setRenderer(render: ThumbnailRenderFn | null): void {
    this.render = render
    this.pump()
  }

  /**
   * A slide's content as it is now. Renders it — after the debounce for an
   * edit (`debounce`), at once or at idle per `request` — unless its picture
   * is already shown or cached.
   */
  setSlide(
    slideId: string,
    inputs: ThumbnailInputs,
    how: { request: ThumbnailRequest; debounce?: boolean },
  ): void {
    if (this.stopped) return
    const state = this.slides.get(slideId)
    const serialised =
      state !== undefined && sameDocumentInputs(state.inputs, inputs)
        ? state.serialised
        : serialiseThumbnailInputs(inputs)
    const key = thumbnailKeyOf(serialised, inputs, this.env)
    if (state === undefined) {
      this.slides.set(slideId, {
        inputs,
        serialised,
        key,
        shown: undefined,
        failures: 0,
        liveMisses: 0,
      })
    } else {
      state.inputs = inputs
      state.serialised = serialised
      if (state.key === key) return
      state.key = key
      // New content: a new retry budget, new live attempts.
      state.failures = 0
      state.liveMisses = 0
      this.clearRetry(slideId)
    }
    if (this.showCached(slideId)) {
      this.cancelDebounce(slideId)
      this.urgent.delete(slideId)
      this.idle.delete(slideId)
      return
    }
    if (how.debounce === true) this.debounce(slideId)
    else this.enqueue(slideId, how.request)
  }

  /**
   * Work out every slide's key again (the colour tokens or a font family
   * changed) and render, at idle, the ones whose picture is no longer theirs.
   */
  refreshKeys(): void {
    for (const [id, state] of this.slides) {
      this.setSlide(id, state.inputs, { request: 'idle' })
    }
  }

  /**
   * The slides the store keeps, in deck order: any other slide is forgotten
   * (its picture released, its render dropped).
   */
  retain(slideIds: Iterable<string>): void {
    const keep = new Set(slideIds)
    let changed = false
    for (const id of [...this.slides.keys()]) {
      if (keep.has(id)) continue
      const state = this.slides.get(id)!
      if (state.shown !== undefined) {
        this.release(state.shown)
        changed = true
      }
      this.slides.delete(id)
      this.cancelDebounce(id)
      this.clearRetry(id)
      this.urgent.delete(id)
      this.idle.delete(id)
      this.held.delete(id)
    }
    if (changed) this.notify()
  }

  /** The slides in view (the panel's rows on screen): rendered before the rest. */
  setVisible(slideIds: Iterable<string> | null): void {
    this.visible = slideIds === null ? null : new Set(slideIds)
    this.pump()
  }

  /**
   * A pointer gesture started or ended: while one is in progress no edit's
   * render starts; when it ends, the held ones are queued.
   */
  setGestureActive(active: boolean): void {
    if (this.gesture === active) return
    this.gesture = active
    if (active) return
    for (const id of this.held) this.enqueue(id, 'urgent', false)
    this.held.clear()
    this.pump()
  }

  /** Start keeping slides (again, after stop()). */
  start(): void {
    this.stopped = false
    liveStores.add(this)
  }

  /**
   * Drop everything: no render starts any more, every URL is revoked, every
   * slide forgotten (listeners stay: they unsubscribe themselves).
   */
  stop(): void {
    this.stopped = true
    this.generation += 1
    this.inFlight = null
    liveStores.delete(this)
    this.render = null
    for (const t of this.debounces.values()) this.clock.clearTimeout(t)
    for (const t of this.retries.values()) this.clock.clearTimeout(t)
    if (this.idleHandle !== null) this.clock.cancelIdle(this.idleHandle)
    this.idleHandle = null
    this.debounces.clear()
    this.retries.clear()
    this.urgent.clear()
    this.idle.clear()
    this.held.clear()
    this.parked.clear()
    this.slides.clear()
    for (const picture of this.pictures.values()) this.urls.revoke(picture.url)
    this.pictures.clear()
    this.unused.clear()
    this.notify()
  }

  // -------------------------------------------------------------------------
  // Pictures
  // -------------------------------------------------------------------------

  /** Show the cached picture of the slide's key, if there is one. */
  private showCached(slideId: string): boolean {
    const state = this.slides.get(slideId)!
    if (state.shown === state.key) return true
    const picture = this.pictures.get(state.key)
    if (picture === undefined) return false
    perfCount('thumb.reused')
    this.show(state, state.key)
    this.notify()
    return true
  }

  private show(state: SlideState, key: string): void {
    if (state.shown === key) return
    const picture = this.pictures.get(key)!
    picture.refs += 1
    this.unused.delete(key)
    if (state.shown !== undefined) this.release(state.shown)
    state.shown = key
  }

  private release(key: string): void {
    const picture = this.pictures.get(key)
    if (picture === undefined) return
    picture.refs -= 1
    if (picture.refs > 0) return
    this.unused.add(key)
    this.trimUnused()
  }

  /** Revoke the oldest pictures no slide shows, beyond `cacheSize`. */
  private trimUnused(): void {
    while (this.unused.size > this.cacheSize) {
      const oldest = this.unused.values().next().value as string
      this.unused.delete(oldest)
      const evicted = this.pictures.get(oldest)
      this.pictures.delete(oldest)
      if (evicted !== undefined) this.urls.revoke(evicted.url)
    }
  }

  /** A render of `key` finished: every slide with that content shows it. */
  private store(key: string, blob: Blob): void {
    if (!this.pictures.has(key)) {
      this.pictures.set(key, { url: this.urls.create(blob), refs: 0 })
      this.unused.add(key)
    }
    for (const state of this.slides.values()) {
      if (state.key === key) this.show(state, key)
    }
    // Nobody wanted it any more (edited meanwhile): it waits in the LRU.
    this.trimUnused()
    this.notify()
  }

  private notify(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private debounce(slideId: string): void {
    this.cancelDebounce(slideId)
    this.urgent.delete(slideId)
    this.idle.delete(slideId)
    this.debounces.set(
      slideId,
      this.clock.setTimeout(() => {
        this.debounces.delete(slideId)
        if (this.gesture) this.held.add(slideId)
        else this.enqueue(slideId, 'urgent')
      }, this.debounceMs),
    )
  }

  private cancelDebounce(slideId: string): void {
    const t = this.debounces.get(slideId)
    if (t !== undefined) this.clock.clearTimeout(t)
    this.debounces.delete(slideId)
    this.held.delete(slideId)
  }

  private enqueue(slideId: string, request: ThumbnailRequest, pump = true): void {
    if (!this.slides.has(slideId)) return
    if (request === 'urgent') {
      this.idle.delete(slideId)
      this.urgent.add(slideId)
    } else if (!this.urgent.has(slideId)) {
      this.idle.add(slideId)
    }
    if (pump) this.pump()
  }

  /** Does the slide still need a render (its picture not shown, cached or being made)? */
  private needsRender(slideId: string): boolean {
    const state = this.slides.get(slideId)
    if (state === undefined) return false
    if (this.showCached(slideId)) return false
    return !(this.inFlight !== null && this.inFlight.key === state.key)
  }

  private isVisible(slideId: string): boolean {
    return this.visible === null || this.visible.has(slideId)
  }

  /** The next slide to render, and whether it may run now (an idle one waits for an idle callback). */
  private next(): { slideId: string; now: boolean } | null {
    for (const id of this.urgent) {
      if (this.needsRender(id)) return { slideId: id, now: true }
      this.urgent.delete(id)
    }
    let hidden: string | undefined
    for (const id of this.idle) {
      if (!this.needsRender(id)) {
        this.idle.delete(id)
        continue
      }
      if (this.isVisible(id)) return { slideId: id, now: true }
      hidden ??= id
    }
    return hidden === undefined ? null : { slideId: hidden, now: false }
  }

  private pump(): void {
    if (this.stopped || this.inFlight !== null || this.gesture) return
    const render = this.render
    if (render === null) return
    const next = this.next()
    if (next === null) return
    if (!next.now && !this.idleGranted) {
      if (this.idleHandle === null) {
        this.idleHandle = this.clock.requestIdle(() => {
          this.idleHandle = null
          this.idleGranted = true
          try {
            this.pump()
          } finally {
            this.idleGranted = false
          }
        }, IDLE_TIMEOUT_MS)
      }
      return
    }
    this.urgent.delete(next.slideId)
    this.idle.delete(next.slideId)
    this.run(next.slideId, render)
  }

  private run(slideId: string, render: ThumbnailRenderFn): void {
    const state = this.slides.get(slideId)!
    const { key, inputs } = state
    this.inFlight = { slideId, key }
    const generation = this.generation
    const isCurrent = (): boolean => !this.stopped && this.generation === generation

    const offscreen = (): Promise<Blob> => render(inputs)
    const capture = state.liveMisses < LIVE_ATTEMPTS ? (this.live?.(slideId, inputs) ?? null) : null
    // A capture that did not settle (null) or failed: keep the picture and
    // try again later, or render offscreen (liveMissed decides).
    const missed = (): Promise<Blob | null> | null =>
      this.liveMissed(slideId, key) ? null : offscreen()
    const result: Promise<Blob | null> =
      capture === null
        ? offscreen()
        : capture.then(
            (blob) => (blob !== null ? blob : missed()),
            () => missed(),
          )

    result
      .then((blob) => {
        if (!isCurrent() || blob === null) return
        this.consecutiveFailures = 0
        const current = this.slides.get(slideId)
        if (current !== undefined && current.key === key) {
          current.failures = 0
          current.liveMisses = 0
        }
        // The renderer works: what was parked while it did not gets another go.
        for (const parked of this.parked) {
          const s = this.slides.get(parked)
          if (s !== undefined) s.failures = 0
          this.enqueue(parked, 'idle', false)
        }
        this.parked.clear()
        this.store(key, blob)
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return
        if (err instanceof Error && err.message.includes(DESTROYED) && this.render !== render) {
          return
        }
        this.failed(slideId, key, err)
      })
      .finally(() => {
        if (this.generation !== generation) return
        this.inFlight = null
        this.pump()
      })
  }

  /**
   * The live capture of `key` did not settle. True when the slide keeps its
   * current picture and the capture is tried again at idle; false when it
   * must be rendered offscreen now (it has no picture yet, or the capture
   * has missed `LIVE_ATTEMPTS` times for this content).
   */
  private liveMissed(slideId: string, key: string): boolean {
    const state = this.slides.get(slideId)
    if (state === undefined || this.stopped || this.inFlight?.slideId !== slideId) return true
    if (state.key !== key) return true // edited meanwhile: its new content is queued
    state.liveMisses += 1
    if (state.shown === undefined || state.liveMisses >= LIVE_ATTEMPTS) {
      // The last attempt (or the first picture) is the offscreen render, at idle.
      if (state.shown !== undefined) {
        this.enqueue(slideId, 'idle', false)
        return true
      }
      return false
    }
    perfCount('thumb.live.kept')
    this.retryLater(slideId, LIVE_RETRY_MS)
    return true
  }

  private failed(slideId: string, key: string, err: unknown): void {
    const state = this.slides.get(slideId)
    this.consecutiveFailures += 1
    if (state === undefined || state.key !== key) {
      // Gone, or edited meanwhile (its new content is queued): no retry from here.
      console.error('[thumbnails] render failed:', err)
      return
    }
    state.failures += 1
    if (state.failures === 1) console.error('[thumbnails] render failed:', err)
    else console.warn(`[thumbnails] render failed again (${state.failures}×):`, err)

    const decision = decideThumbnailRetry({
      slideFailures: state.failures,
      consecutiveFailures: this.consecutiveFailures,
    })
    switch (decision.kind) {
      case 'retry':
        this.retryLater(slideId, decision.delayMs)
        return
      case 'park':
        if (this.consecutiveFailures === THUMBNAIL_RETRY_POLICY.rendererFailureLimit) {
          console.warn(
            `[thumbnails] ${this.consecutiveFailures} thumbnail renders failed in a row; ` +
              'retries wait until a render succeeds',
          )
        }
        this.parked.add(slideId)
        return
      case 'give-up':
        console.warn(
          `[thumbnails] giving up on the thumbnail of ${slideId} after ` +
            `${state.failures} failed renders; the next change to the slide tries again`,
        )
        return
    }
  }

  /** Queue the slide again (at idle) after `ms`, keeping its failure count. */
  private retryLater(slideId: string, ms: number): void {
    this.clearRetry(slideId)
    this.retries.set(
      slideId,
      this.clock.setTimeout(() => {
        this.retries.delete(slideId)
        this.enqueue(slideId, 'idle')
      }, ms),
    )
  }

  private clearRetry(slideId: string): void {
    const t = this.retries.get(slideId)
    if (t !== undefined) this.clock.clearTimeout(t)
    this.retries.delete(slideId)
    this.parked.delete(slideId)
  }
}
