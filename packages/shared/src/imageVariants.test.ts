import { describe, expect, it } from 'vitest'
import { imageVariantRank, isImageVariant, screenImageVariant } from './imageVariants.js'

describe('screenImageVariant', () => {
  it('is the smallest variant with a texel for every device pixel drawn', () => {
    expect(screenImageVariant({ drawnLongSide: 640, density: 2, sourceLongSide: 3000 })).toBe(
      'medium',
    )
    expect(screenImageVariant({ drawnLongSide: 641, density: 2, sourceLongSide: 3000 })).toBe(
      'display',
    )
    // Even display short of it: display, the most there is.
    expect(screenImageVariant({ drawnLongSide: 1920, density: 4, sourceLongSide: 3000 })).toBe(
      'display',
    )
  })

  it('is medium for a source up to 1280 px, display for an unknown one', () => {
    expect(screenImageVariant({ drawnLongSide: 1920, density: 2, sourceLongSide: 1280 })).toBe(
      'medium',
    )
    expect(screenImageVariant({ drawnLongSide: 10, density: 1, sourceLongSide: null })).toBe(
      'display',
    )
    expect(screenImageVariant({ drawnLongSide: 10, density: 1, sourceLongSide: 0 })).toBe('display')
  })
})

describe('variants', () => {
  it('rank by pixels and are told from other strings', () => {
    expect(imageVariantRank('preview')).toBeLessThan(imageVariantRank('medium'))
    expect(imageVariantRank('medium')).toBeLessThan(imageVariantRank('display'))
    expect(isImageVariant('medium')).toBe(true)
    expect(isImageVariant('4k')).toBe(false)
  })
})
