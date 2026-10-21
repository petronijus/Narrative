/**
 * present/preloadMedia.test.ts — what present mode fetches before it is
 * ready: each picture once, in the largest variant its uses need
 * (performance.md → L3), and the pinned variants beside.
 */

import { describe, expect, it } from 'vitest'
import type { Slide, SlideObject } from '@narrative/shared'
import { picturesToFetch } from './preloadMedia'

const img = (id: string, assetId: string, width: number, height: number, extra = {}) =>
  ({
    id,
    type: 'image',
    x: 0,
    y: 0,
    width,
    height,
    rotation: 0,
    opacity: 1,
    assetId,
    ...extra,
  }) as SlideObject
const slide = (objects: SlideObject[], extra: Record<string, unknown> = {}): Slide =>
  ({ id: `s${Math.random()}`, objects, ...extra }) as Slide

const sizes = new Map(
  ['p', 'q', 'bg', 'fill', 'pin'].map((id) => [id, { assetId: id, width: 3000, height: 2000 }]),
)

describe('picturesToFetch', () => {
  it('fetches a picture once, in the largest variant any slide needs', () => {
    const slides = [
      slide([img('a', 'p', 340, 240)]),
      slide([img('b', 'p', 1920, 1080), img('c', 'q', 340, 240)]),
    ]
    const { fetch, variants } = picturesToFetch(slides, 1, sizes)
    expect(fetch).toEqual([
      { assetId: 'p', variant: 'display' },
      { assetId: 'q', variant: 'medium' },
    ])
    expect(variants.get('p')).toBe('display')
    expect(variants.get('q')).toBe('medium')
    // 340 × 240 under cover is drawn 360 wide: at 4× that is 1440 px, past medium.
    expect(picturesToFetch([slides[1]!], 4, sizes).variants.get('q')).toBe('display')
  })

  it('fetches backgrounds and fills at display, and a pinned variant beside the screen one', () => {
    const rect = {
      id: 'r',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      opacity: 1,
      fillStyle: { kind: 'image', assetId: 'fill' },
    } as unknown as SlideObject
    const slides = [
      slide([rect, img('o', 'pin', 100, 100, { variant: 'original' }), img('m', 'pin', 100, 100)], {
        background: { kind: 'image', assetId: 'bg' },
      }),
    ]
    const { fetch, variants } = picturesToFetch(slides, 1, sizes)
    expect(new Set(fetch.map((f) => `${f.assetId}:${f.variant}`))).toEqual(
      new Set(['bg:display', 'fill:display', 'pin:medium', 'pin:original']),
    )
    // The pin is no floor for the other objects of its picture.
    expect(variants.get('pin')).toBe('medium')
  })

  it('sizes a picture for its source either way up (an EXIF-turned photo is served turned)', () => {
    // A 400 × 900 frame at 1×: the row's 2000 × 3000 (portrait) under cover
    // is drawn 600 × 900 (medium); served turned, 3000 × 2000, it is drawn
    // 1350 × 900 (display). The fetch takes the larger.
    const turned = new Map([['t', { assetId: 't', width: 2000, height: 3000 }]])
    const { variants } = picturesToFetch([slide([img('a', 't', 400, 900)])], 1, turned)
    expect(variants.get('t')).toBe('display')
  })

  it('fetches display for a picture a build scales up and for the slides a Magic Move joins', () => {
    const zoomed = slide([img('z', 'p', 340, 240)], {
      animations: [{ objectId: 'z', preset: 'zoomIn', easing: '' }],
    })
    expect(picturesToFetch([zoomed], 1, sizes).variants.get('p')).toBe('display')
    const before = slide([img('a', 'p', 340, 240)])
    const magic = slide([img('b', 'q', 340, 240)], {
      transition: { kind: 'magic', durationMs: 500 },
    })
    const after = slide([img('c', 'bg', 340, 240)])
    const { variants } = picturesToFetch([before, magic, after], 1, sizes)
    expect(variants.get('p')).toBe('display')
    expect(variants.get('q')).toBe('display')
    expect(variants.get('bg')).toBe('medium')
  })
})
