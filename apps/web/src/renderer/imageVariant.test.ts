// @vitest-environment node
/**
 * renderer/imageVariant.test.ts — which variant an image object is drawn from
 * (performance.md → L3): never one with fewer pixels than the canvas covers.
 */

import { describe, expect, it } from 'vitest'
import type { ImageObject } from '@narrative/shared'
import {
  drawnLongSide,
  imageObjectVariant,
  morphingSlides,
  scaledUpObjectIds,
  scalesUp,
} from './imageVariant'

const photo = { width: 3000, height: 2000 }
const image = (o: Partial<ImageObject>): ImageObject => ({
  id: 'i',
  type: 'image',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  rotation: 0,
  opacity: 1,
  assetId: 'a',
  variant: 'display',
  ...o,
})

describe('drawnLongSide', () => {
  it('is the sprite applyFit lays out: cover overflows the frame, contain fits it', () => {
    // 3:2 photo in a 400 × 400 frame: cover 600 × 400, contain 400 × 267.
    expect(drawnLongSide(image({ width: 400, height: 400 }), photo)).toBeCloseTo(600)
    expect(drawnLongSide(image({ width: 400, height: 400, fit: 'contain' }), photo)).toBeCloseTo(
      400,
    )
  })

  it('reads the imageRect of a cropped picture, not its frame', () => {
    const cropped = image({ imageRect: { x: -300, y: 0, width: 1200, height: 800 } })
    expect(drawnLongSide(cropped, photo)).toBeCloseTo(1200)
  })
})

describe('imageObjectVariant', () => {
  it('takes medium up to 1280 device pixels and display above', () => {
    expect(imageObjectVariant(image({ width: 640, height: 426 }), photo, 2)).toBe('medium')
    expect(imageObjectVariant(image({ width: 660, height: 440 }), photo, 2)).toBe('display')
    expect(imageObjectVariant(image({ width: 1280, height: 853 }), photo, 1)).toBe('medium')
    expect(imageObjectVariant(image({ width: 1920, height: 1080 }), photo, 1)).toBe('display')
  })

  it('takes medium for a source of at most 1280 px at any size (the same pixels)', () => {
    expect(imageObjectVariant(image({ width: 1920 }), { width: 1200, height: 800 }, 4)).toBe(
      'medium',
    )
  })

  it('takes display without a density or a source size, and keeps a pin', () => {
    expect(imageObjectVariant(image({}), photo, null)).toBe('display')
    expect(imageObjectVariant(image({}), { width: null, height: null }, 1)).toBe('display')
    expect(imageObjectVariant(image({ variant: 'original' }), photo, 1)).toBe('original')
    expect(imageObjectVariant(image({ variant: 'thumb' }), photo, 4)).toBe('thumb')
    const { variant: _omit, ...unpinned } = image({})
    expect(imageObjectVariant(unpinned, photo, 1)).toBe('medium')
  })
})

describe('pictures drawn larger than at rest', () => {
  it('are those a build scales up: zoomIn, popIn, an overshooting scaleIn or bounceIn', () => {
    expect(scalesUp({ preset: 'zoomIn', easing: '' })).toBe(true)
    expect(scalesUp({ preset: 'popIn', easing: '' })).toBe(true)
    expect(scalesUp({ preset: 'scaleIn', easing: 'back.out(2)' })).toBe(true)
    expect(scalesUp({ preset: 'bounceIn', easing: 'elastic.out' })).toBe(true)
    expect(scalesUp({ preset: 'scaleIn', easing: 'power2.out' })).toBe(false)
    expect(scalesUp({ preset: 'bounceIn', easing: '' })).toBe(false)
    expect(scalesUp({ preset: 'fadeIn', easing: 'back.out' })).toBe(false)
    const ids = scaledUpObjectIds({
      animations: [
        { objectId: 'a', preset: 'zoomIn', easing: '' },
        { objectId: 'b', preset: 'fadeIn', easing: '' },
      ] as never,
    })
    expect([...ids]).toEqual(['a'])
  })

  it('and those of the slides a Magic Move joins, both ways', () => {
    const t = (kind: string) => ({ transition: { kind, durationMs: 500 } }) as never
    expect([...morphingSlides([t('none'), t('magic'), t('fade'), t('none')])]).toEqual([1, 0])
    expect([...morphingSlides([t('magic')])]).toEqual([0])
  })
})
