import { describe, expect, it } from 'vitest'
import { crowdedSlideOps, deckOps, lightSlideOps } from './scenes.js'

describe('scenes', () => {
  it('the crowded slide: every object once, probes last, the same on every call', () => {
    const a = crowdedSlideOps({ texts: 120, images: 40, rects: 60 }, ['a1', 'a2'])
    const b = crowdedSlideOps({ texts: 120, images: 40, rects: 60 }, ['a1', 'a2'])
    expect(a.ops).toEqual(b.ops)
    expect(a.ops).toHaveLength(223)
    expect(a.boxes.size).toBe(223)
    expect(a.ops.slice(-3).map((o) => (o.input as { id: string }).id)).toEqual([
      'probe-rect',
      'probe-text',
      'probe-img',
    ])
    expect(a.ops.every((o) => o.command === 'object.create')).toBe(true)
  })

  it('the light slide: a text and twelve rectangles', () => {
    const { ops, boxes } = lightSlideOps()
    expect(ops).toHaveLength(13)
    expect([...boxes.keys()][0]).toBe('perf-text')
  })

  it('a deck: the slides added first, then twelve objects per slide by index', () => {
    const { ops, perSlide } = deckOps(10, ['x'])
    expect(ops.filter((o) => o.command === 'slide.add')).toHaveLength(9)
    expect(ops.slice(0, 9).every((o) => o.command === 'slide.add')).toBe(true)
    expect(perSlide).toHaveLength(10)
    expect(perSlide.every((ids) => ids.length === 12)).toBe(true)
    const last = ops.at(-1)!.input as { slide: { index: number } }
    expect(last.slide).toEqual({ index: 9 })
  })
})
