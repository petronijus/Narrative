/**
 * state/useSlideBackground.ts
 *
 * The active slide's `SlideBackground`, selected from the deck's shared store:
 * the snapshot keeps its identity until the background changes, so an object
 * edit does not re-render the caller.
 *
 * If the active slide has no `background` set, returns
 * `DEFAULT_BACKGROUND` so consumers never have to null-check.
 */

import { DEFAULT_BACKGROUND, type SlideBackground } from '@narrative/shared'
import { useDeckSelector } from './useDeckStore.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export function useSlideBackground(): SlideBackground {
  const { activeSlideId } = useActiveSlide()
  return useDeckSelector((store) =>
    activeSlideId === null
      ? DEFAULT_BACKGROUND
      : (store.getSlide(activeSlideId)?.background ?? DEFAULT_BACKGROUND),
  )
}
