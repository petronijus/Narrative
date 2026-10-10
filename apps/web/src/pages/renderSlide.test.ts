import { describe, expect, it } from 'vitest'
import type { Slide } from '@narrative/shared'
import { resolveRenderSlide } from './renderSlide'

const slides = [{ id: 'aa' }, { id: 'bb' }, { id: '7' }] as unknown as Slide[]

describe('resolveRenderSlide', () => {
  it('shows the first slide without ?slide=', () => {
    expect(resolveRenderSlide(slides, null)).toEqual({ slide: slides[0], index: 0 })
    expect(resolveRenderSlide(slides, '')).toEqual({ slide: slides[0], index: 0 })
  })

  it('takes a slide id, preferring it over an index of the same spelling', () => {
    expect(resolveRenderSlide(slides, 'bb')).toEqual({ slide: slides[1], index: 1 })
    expect(resolveRenderSlide(slides, '7')).toEqual({ slide: slides[2], index: 2 })
  })

  it('takes a 0-based index', () => {
    expect(resolveRenderSlide(slides, '1')).toEqual({ slide: slides[1], index: 1 })
  })

  it('finds nothing for an unknown id, an index past the end, or an empty deck', () => {
    expect(resolveRenderSlide(slides, 'zz')).toBeNull()
    expect(resolveRenderSlide(slides, '3')).toBeNull()
    expect(resolveRenderSlide([], null)).toBeNull()
  })
})
