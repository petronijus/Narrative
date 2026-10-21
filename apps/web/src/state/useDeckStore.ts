/**
 * state/useDeckStore.ts
 *
 * React access to the deck's shared read model (`getDeckStore`,
 * packages/slide-model/src/deckStore.ts; performance.md → E1, E6).
 *
 * The store is a derived, read-only cache of the Y.Doc — it holds no data of
 * its own, so this is not the "parallel React state for object data" the
 * hard rules forbid: Yjs stays the only source of truth, the store is how
 * every component reads it without each one deep-copying the deck. Its
 * snapshots are structurally shared (an object that did not change keeps its
 * identity), which is what lets `useDeckSelector` re-render a component only
 * when what it selected changed: an Inspector row showing one object does not
 * re-render when another object moves.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import { getDeckStore, type DeckStore } from '@narrative/slide-model'
import type { AnimationStep, Slide, SlideObject } from '@narrative/shared'
import { useSlideDoc } from './useSlideDoc.js'
import { useActiveSlide } from './ActiveSlideContext.js'

/** The shared store of the document in context. */
export function useDeckStore(): DeckStore {
  const { deckCtx } = useSlideDoc()
  return getDeckStore(deckCtx)
}

/**
 * Select a value from the deck; re-renders only when the selection changes
 * (`isEqual`, identity by default). The selector may be an inline closure:
 * it runs again when the deck changed or when it is a new function, and an
 * equal result keeps the previous value (and so the previous identity).
 */
export function useDeckSelector<T>(
  select: (store: DeckStore) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useDeckStore()
  const memo = useRef<{
    store: DeckStore
    version: Slide[]
    select: (store: DeckStore) => T
    value: T
  } | null>(null)
  const getSnapshot = useCallback((): T => {
    // Any change to the deck gives a new slide list: it is the version.
    const version = store.getSlides()
    const prev = memo.current
    if (prev !== null && prev.store === store && prev.version === version && prev.select === select)
      return prev.value
    const next = select(store)
    const value =
      prev !== null && prev.store === store && isEqual(prev.value, next) ? prev.value : next
    memo.current = { store, version, select, value }
    return value
  }, [store, select, isEqual])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

const NO_OBJECTS: SlideObject[] = []
const NO_ANIMATIONS: AnimationStep[] = []

/** Every slide, in deck order (the same array until something in it changes). */
export function useDeckSlides(): Slide[] {
  return useDeckSelector(selectSlides)
}
const selectSlides = (store: DeckStore): Slide[] => store.getSlides()

/** The active slide's objects in z-order (back to front); empty when there is no active slide. */
export function useActiveSlideObjects(): SlideObject[] {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector((store) =>
    activeSlideId === null ? NO_OBJECTS : (store.getSlide(activeSlideId)?.objects ?? NO_OBJECTS),
  )
}

/** One object of the active slide by id: re-renders only when that object changes. */
export function useActiveSlideObject(objectId: string | null): SlideObject | undefined {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector((store) =>
    activeSlideId === null || objectId === null
      ? undefined
      : store.getObject(activeSlideId, objectId),
  )
}

/**
 * Two snapshots of an object with the same fields: the same keys, each value
 * the same by identity. A Yjs type the object holds (a text's Y.Text) is the
 * same live instance across snapshots, so a change *inside* it — a typed
 * word, an inline format, a list indent — leaves the fields the same, while
 * any write of a key does not (the store hands out the value a Y.Map holds,
 * by reference, so an unchanged key keeps its identity; a write gives a new
 * value even when it is equal, which errs on the side of re-rendering).
 */
export function sameObjectFields(a: SlideObject | undefined, b: SlideObject | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const keys = Object.keys(ra)
  if (keys.length !== Object.keys(rb).length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(rb, k) || ra[k] !== rb[k]) return false
  }
  return true
}

/**
 * One object of the active slide by id, re-rendering only when one of its
 * fields changes (`sameObjectFields`) — not when the content of a Yjs type it
 * holds does: typing into a text box does not re-render the reader
 * (performance.md → E6). The snapshot returned may therefore be older than
 * the document; its Yjs types are the live ones. A reader that shows what is
 * inside them (the text, its runs or paragraphs) subscribes to that itself
 * (`ui/useTextRunAttrs.ts`); every other reader can use this.
 */
export function useActiveSlideObjectFields(objectId: string | null): SlideObject | undefined {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector(
    (store) =>
      activeSlideId === null || objectId === null
        ? undefined
        : store.getObject(activeSlideId, objectId),
    sameObjectFields,
  )
}

/**
 * The active slide's objects that pass `keep`, in z-order: re-renders only
 * when that set changes or one of its objects does (an overlay of locked
 * objects does not re-render while another object is dragged).
 */
export function useActiveSlideObjectsWhere(keep: (o: SlideObject) => boolean): SlideObject[] {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector((store) => {
    if (activeSlideId === null) return NO_OBJECTS
    const all = store.getSlide(activeSlideId)?.objects ?? NO_OBJECTS
    const kept = all.filter(keep)
    return kept.length === 0 ? NO_OBJECTS : kept
  }, sameArray)
}

/** The active slide's objects with these ids (in z-order; missing ids skipped). */
export function useActiveSlideObjectsById(ids: readonly string[]): SlideObject[] {
  const wanted = ids.length === 0 ? null : new Set(ids)
  return useActiveSlideObjectsWhere((o) => wanted !== null && wanted.has(o.id))
}

/** The active slide's animation steps in play order. */
export function useActiveSlideAnimations(): AnimationStep[] {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector((store) =>
    activeSlideId === null
      ? NO_ANIMATIONS
      : (store.getSlide(activeSlideId)?.animations ?? NO_ANIMATIONS),
  )
}

export const SLIDE_IDS_KEY_SEPARATOR = '\n'
const selectSlideIdsKey = (store: DeckStore): string =>
  store
    .getSlides()
    .map((s) => s.id)
    .join(SLIDE_IDS_KEY_SEPARATOR)

/**
 * The slide ids in deck order, joined by `SLIDE_IDS_KEY_SEPARATOR`: a string
 * compares by value, so an edit inside a slide selects the same key and does
 * not re-render the reader. Changes when a slide is added, removed or moved.
 */
export function useSlideIdsKey(): string {
  return useDeckSelector(selectSlideIdsKey)
}

/** Shallow equality of two arrays (same elements, same order) — for selectors that map. */
export function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
