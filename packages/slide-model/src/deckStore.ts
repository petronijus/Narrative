/**
 * slide-model/src/deckStore.ts
 *
 * One shared, structurally shared read model of a deck (performance.md → E1).
 *
 * WHY THIS EXISTS. The editor used to read the deck through `listSlides`, a
 * deep copy of every slide and every object, once per subscriber per frame:
 * six copies of 1 338 objects per pointer move of a drag on a crowded slide,
 * each a fresh array that defeated every `memo` below it. This store keeps
 * ONE snapshot per Y.Doc and rebuilds only what a transaction touched: an
 * object's snapshot is reused for as long as its Y.Map (and everything under
 * it) did not change, a slide's for as long as none of its parts did, and
 * the slide list for as long as no slide did. Readers can therefore compare
 * by identity: `prev === next` means "nothing this snapshot shows changed".
 *
 * IT IS NOT A SECOND SOURCE OF TRUTH (ADR 0003). It holds no data of its own
 * and accepts no writes: every value is derived from the Y.Doc, invalidated
 * by the Y.Doc's own events and rebuilt from the Y.Doc. Writes still go
 * through commands; the store sees their result when Yjs reports it. Its
 * values have exactly the shape `listSlides` returns (both build slides with
 * `composeSlide` / `readSlideMeta` and objects with `yMapToPlainObject`), so
 * reading one instead of the other changes nothing but identity.
 *
 * INVALIDATION. One `observeDeep` on the deck's slides Y.Array. Each event's
 * target is walked up its parent chain to the slide Y.Map it lives in and
 * classified by the slide key it sits under:
 *   - the slides array itself             → the list (slides added, removed, moved)
 *   - a key of the slide Y.Map itself     → that part (`objects`, `animations`, or metadata)
 *   - `objects`, the array itself         → the slide's object list (insert / delete / reorder)
 *   - `objects`, inside one object        → that object (any depth: a Y.Text, a table cell)
 *   - `animations`                        → the slide's animation steps
 *   - `transition` / `background`         → the slide's metadata
 *   - any other key (speaker notes)       → nothing: no snapshot shows it
 * Origins do not matter: local edits, undo/redo, remote updates and the
 * first sync all arrive as the same events.
 *
 * TIMING. Reads are always current: a read after a transaction rebuilds what
 * that transaction invalidated (so `getSlides()` equals `listSlides(ctx)` at
 * any moment, structurally). Subscribers are told once per animation frame (a
 * microtask where there is no rAF), like the subscriptions this replaces
 * (`subscribeToSlides`, `subscribeToSlideObjects`): a burst of transactions
 * — a drag's pointer moves, a typed word — is one notification. A read from
 * inside another Yjs observer of the same transaction may run before this
 * store's observer and see the state before that transaction.
 */

import * as Y from 'yjs'
import { perfCount, type AnimationStep, type Slide, type SlideObject } from '@narrative/shared'
import { yMapToPlainObject } from './bindings.js'
import { yMapToAnimationStep } from './animationBindings.js'
import { composeSlide, readSlideMeta, type SlideMeta, type SlideMutationContext } from './slides.js'

/** A shared, structurally shared snapshot of one deck. Read-only: never mutate what it returns. */
export interface DeckStore {
  /** Every slide in deck order; the same array until a slide is added, removed, moved or changed. */
  getSlides(): Slide[]
  /** The slide with this id, or undefined. */
  getSlide(slideId: string): Slide | undefined
  /** An object of a slide by id, or undefined. */
  getObject(slideId: string, objectId: string): SlideObject | undefined
  /**
   * Calls `listener` (no arguments) once per frame in which the snapshot
   * changed; returns the unsubscribe. Read the new state with the getters.
   */
  subscribe(listener: () => void): () => void
  /** Tell subscribers now about a pending change instead of at the next frame (tests). */
  flush(): void
  /** Detach from the document (tests); the store then serves its last snapshot. */
  destroy(): void
}

interface SlideDirt {
  meta: boolean
  animations: boolean
  objects: boolean
}

/** An object Y.Map without a readable `type`: skipped, as `listSlides` skips it. */
const MALFORMED = Symbol('malformed')
type ObjectEntry = SlideObject | typeof MALFORMED

type AnyType = Y.AbstractType<unknown>

/** Array-likes the store walks: a Y.Array, or the plain test doubles of `createMockSlideDocValue`. */
interface Indexed<T> {
  length: number
  get(index: number): T
}

function parentOf(t: AnyType): AnyType | null {
  const p = (t as unknown as { parent: unknown }).parent
  return p instanceof Y.AbstractType ? (p as AnyType) : null
}

/** The key a type sits under in its parent Y.Map (undefined inside a Y.Array). */
function parentSubOf(t: AnyType): string | undefined {
  const item = (t as unknown as { _item: { parentSub: string | null } | null })._item
  return item?.parentSub ?? undefined
}

/** Deep equality of plain JSON-like values (slide metadata, animation steps). */
function plainEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    if (a.length !== bb.length) return false
    for (let i = 0; i < a.length; i++) if (!plainEqual(a[i], bb[i])) return false
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k)) return false
    if (!plainEqual(ra[k], rb[k])) return false
  }
  return true
}

/** Same elements in the same order. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function isIndexed(v: unknown): v is Indexed<unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Indexed<unknown>).length === 'number' &&
    typeof (v as Indexed<unknown>).get === 'function'
  )
}

/**
 * Build a store over `ctx`. Callers want `getDeckStore`, which shares one per
 * document; this is for tests and for a caller with its own scheduling
 * (`schedule` replaces the frame-aligned notification).
 */
export function createDeckStore(
  ctx: SlideMutationContext,
  options: { schedule?: (notify: () => void) => void } = {},
): DeckStore {
  // Snapshot caches keyed by Y type identity: a replaced slide or object
  // (moveSlide's clone, a collaborator's replacement, the first sync
  // swapping a hydrated slide for the server's) is a new Y.Map and misses.
  const slideCache = new WeakMap<Y.Map<unknown>, Slide>()
  const metaCache = new WeakMap<Y.Map<unknown>, SlideMeta>()
  const objectCache = new WeakMap<Y.Map<unknown>, ObjectEntry>()
  const objectIndexCache = new WeakMap<readonly SlideObject[], Map<string, SlideObject>>()

  // What the transactions since the last rebuild invalidated.
  const dirtySlides = new Map<Y.Map<unknown>, SlideDirt>()
  const dirtyObjects = new Set<Y.Map<unknown>>()
  let pending = true

  let slides: Slide[] = []
  let byId = new Map<string, Slide>()
  /** The snapshot changed since subscribers were last told. */
  let unannounced = false

  const listeners = new Set<() => void>()
  let scheduled = false
  let destroyed = false

  const dirtOf = (slideMap: Y.Map<unknown>): SlideDirt => {
    let d = dirtySlides.get(slideMap)
    if (d === undefined) {
      d = { meta: false, animations: false, objects: false }
      dirtySlides.set(slideMap, d)
    }
    return d
  }

  const readObject = (m: Y.Map<unknown>): ObjectEntry => {
    let entry = dirtyObjects.has(m) ? undefined : objectCache.get(m)
    if (entry === undefined) {
      try {
        entry = yMapToPlainObject(m)
      } catch {
        entry = MALFORMED
      }
      objectCache.set(m, entry)
      perfCount('y.deckStore.objects')
    }
    return entry
  }

  const buildObjects = (
    slideMap: Y.Map<unknown>,
    prev: SlideObject[] | undefined,
  ): SlideObject[] => {
    const arr = slideMap.get('objects')
    const out: SlideObject[] = []
    if (isIndexed(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const m = arr.get(i)
        if (!(m instanceof Y.Map)) continue
        const entry = readObject(m as Y.Map<unknown>)
        if (entry !== MALFORMED) out.push(entry)
      }
    }
    return prev !== undefined && sameItems(prev, out) ? prev : out
  }

  const buildAnimations = (
    slideMap: Y.Map<unknown>,
    prev: AnimationStep[] | undefined,
  ): AnimationStep[] => {
    const arr = slideMap.get('animations')
    const out: AnimationStep[] = []
    if (isIndexed(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const m = arr.get(i)
        if (!(m instanceof Y.Map)) continue
        try {
          out.push(yMapToAnimationStep(m as Y.Map<unknown>))
        } catch {
          // Malformed step — skipped, as listSlides skips it.
        }
      }
    }
    return prev !== undefined && plainEqual(prev, out) ? prev : out
  }

  const buildSlide = (slideMap: Y.Map<unknown>): Slide => {
    const prev = slideCache.get(slideMap)
    const dirt = dirtySlides.get(slideMap)
    if (prev !== undefined && dirt === undefined) return prev
    const objects =
      prev === undefined || dirt!.objects ? buildObjects(slideMap, prev?.objects) : prev.objects
    const animations =
      prev === undefined || dirt!.animations
        ? buildAnimations(slideMap, prev?.animations)
        : prev.animations
    const prevMeta = metaCache.get(slideMap)
    let meta = prevMeta
    if (meta === undefined || prev === undefined || dirt!.meta) {
      const read = readSlideMeta(slideMap)
      meta = prevMeta !== undefined && plainEqual(prevMeta, read) ? prevMeta : read
      metaCache.set(slideMap, meta)
    }
    const id = slideMap.get('id') as string
    if (
      prev !== undefined &&
      prev.id === id &&
      prev.objects === objects &&
      prev.animations === animations &&
      meta === prevMeta
    ) {
      return prev
    }
    const slide = composeSlide(id, objects, animations, meta)
    slideCache.set(slideMap, slide)
    return slide
  }

  /** Bring the snapshot up to date with the document. */
  const refresh = (): void => {
    if (!pending || destroyed) return
    pending = false
    perfCount('y.deckStore.rebuild')
    const list = ctx.slides as unknown as Indexed<unknown>
    const next: Slide[] = []
    for (let i = 0; i < list.length; i++) {
      const slideMap = list.get(i)
      if (slideMap === undefined || slideMap === null) continue
      next.push(buildSlide(slideMap as Y.Map<unknown>))
    }
    dirtySlides.clear()
    dirtyObjects.clear()
    if (sameItems(slides, next)) return
    slides = next
    byId = new Map()
    for (const s of next) if (!byId.has(s.id)) byId.set(s.id, s)
    unannounced = true
  }

  const announce = (): void => {
    scheduled = false
    if (destroyed) return
    refresh()
    if (!unannounced) return
    unannounced = false
    perfCount('y.deckStore.notify')
    for (const l of [...listeners]) l()
  }

  const schedule =
    options.schedule ??
    ((cb: () => void): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raf = (globalThis as any).requestAnimationFrame as
        ((cb: () => void) => number) | undefined
      if (raf !== undefined) raf(cb)
      else void Promise.resolve().then(cb)
    })

  const scheduleAnnounce = (): void => {
    if (scheduled || listeners.size === 0) return
    scheduled = true
    schedule(announce)
  }

  /**
   * Mark what an event invalidates (see the header); false when no snapshot
   * shows what it changed. `keys`: the keys a Y.Map event changed, else null.
   */
  const classify = (target: AnyType, keys: Iterable<string> | null): boolean => {
    const root = ctx.slides as unknown as AnyType
    // The slide list itself: every slide is looked up again (cache hits by
    // Y.Map identity), so there is nothing finer to mark.
    if (target === root) return true
    // Walk up to the slide Y.Map (the direct child of the slides array),
    // keeping the two types below it: `top` sits directly under the slide
    // map, `second` directly under `top`.
    let slideMap: AnyType = target
    let top: AnyType | null = null
    let second: AnyType | null = null
    for (;;) {
      const parent = parentOf(slideMap)
      if (parent === null) return false // not (or no longer) in this deck
      if (parent === root) break
      second = top
      top = slideMap
      slideMap = parent
    }
    if (!(slideMap instanceof Y.Map)) return false
    const d = dirtOf(slideMap as Y.Map<unknown>)
    if (top === null) {
      // Keys of the slide map itself were set or deleted.
      for (const key of keys ?? []) {
        if (key === 'objects') d.objects = true
        else if (key === 'animations') d.animations = true
        else d.meta = true
      }
      return true
    }
    const key = parentSubOf(top)
    if (key === 'objects') {
      d.objects = true
      // `second` is the object's Y.Map when the change is inside an object;
      // null when the objects array itself changed (insert, delete, reorder).
      if (second instanceof Y.Map) dirtyObjects.add(second as Y.Map<unknown>)
      return true
    }
    if (key === 'animations') {
      d.animations = true
      return true
    }
    if (key === 'transition' || key === 'background') {
      d.meta = true
      return true
    }
    return false
  }

  const observer = (events: Array<Y.YEvent<AnyType>>): void => {
    perfCount('y.observeDeep.deckStore')
    let touched = false
    for (const event of events) {
      const keys = event.target instanceof Y.Map ? event.keys.keys() : null
      if (classify(event.target, keys)) touched = true
    }
    if (!touched) return
    pending = true
    scheduleAnnounce()
  }

  ctx.slides.observeDeep(observer)
  refresh()
  unannounced = false

  return {
    getSlides() {
      refresh()
      return slides
    },
    getSlide(slideId) {
      refresh()
      return byId.get(slideId)
    },
    getObject(slideId, objectId) {
      refresh()
      const slide = byId.get(slideId)
      if (slide === undefined) return undefined
      let index = objectIndexCache.get(slide.objects)
      if (index === undefined) {
        index = new Map()
        for (const o of slide.objects) if (!index.has(o.id)) index.set(o.id, o)
        objectIndexCache.set(slide.objects, index)
      }
      return index.get(objectId)
    },
    subscribe(listener) {
      listeners.add(listener)
      if (pending || unannounced) scheduleAnnounce()
      return () => {
        listeners.delete(listener)
      }
    },
    flush() {
      announce()
    },
    destroy() {
      if (destroyed) return
      refresh()
      destroyed = true
      ctx.slides.unobserveDeep(observer)
      listeners.clear()
    },
  }
}

const stores = new WeakMap<object, DeckStore>()

/**
 * The deck's shared store: one per slides Y.Array, created on first use and
 * kept for the document's lifetime (held weakly: it goes with the document).
 */
export function getDeckStore(ctx: SlideMutationContext): DeckStore {
  let store = stores.get(ctx.slides)
  if (store === undefined) {
    store = createDeckStore(ctx)
    stores.set(ctx.slides, store)
  }
  return store
}
