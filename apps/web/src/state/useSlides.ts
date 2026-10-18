/**
 * state/useSlides.ts
 *
 * The full slide list (M9), read from the deck's shared store
 * (state/useDeckStore.ts, performance.md → E1).
 *
 * The array and every slide in it keep their identity until something in
 * them changes: an edit on one slide gives a new array with a new snapshot of
 * that slide and the same snapshots of all the others. Subscribers re-render
 * once per frame at most. A component that needs only part of the deck should
 * select it (`useDeckSelector`) so it does not re-render on every edit.
 */

import type { Slide } from '@narrative/shared'
import { useDeckSelector, useDeckSlides } from './useDeckStore.js'

export function useSlides(): Slide[] {
  return useDeckSlides()
}

/**
 * A value derived from the slide list: re-renders only when it changes
 * (`isEqual`, identity by default). Slides keep their identity until they
 * change, so selecting one slide re-renders only for edits on that slide.
 */
export function useSlidesSelector<T>(
  select: (slides: Slide[]) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useDeckSelector((store) => select(store.getSlides()), isEqual)
}
