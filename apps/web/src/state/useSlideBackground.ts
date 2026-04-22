/**
 * state/useSlideBackground.ts
 *
 * Derives the active slide's `SlideBackground` from the live slide list.
 * Re-renders whenever the deck structure changes — good enough for P2
 * because editing a background is a rare click, not a hot path.
 *
 * If the active slide has no `background` set, returns
 * `DEFAULT_BACKGROUND` so consumers never have to null-check.
 */

import { useMemo } from 'react'
import { DEFAULT_BACKGROUND, type SlideBackground } from '@narrative/shared'
import { useSlides } from './useSlides.js'
import { useActiveSlide } from './ActiveSlideContext.js'

export function useSlideBackground(): SlideBackground {
  const slides = useSlides()
  const { activeSlideId } = useActiveSlide()
  return useMemo(() => {
    if (activeSlideId === null) return DEFAULT_BACKGROUND
    const slide = slides.find((s) => s.id === activeSlideId)
    return slide?.background ?? DEFAULT_BACKGROUND
  }, [slides, activeSlideId])
}
