import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND, DEFAULT_TRANSITION } from '../deck.js'
import {
  DeckGuideSchema,
  MAX_TRANSITION_DURATION_MS,
  SlideBackgroundInputSchema,
  SlideBackgroundSchema,
  SlideTransitionSchema,
} from './deck.js'

describe('SlideTransitionSchema', () => {
  it('accepts the default and every kind', () => {
    expect(SlideTransitionSchema.parse(DEFAULT_TRANSITION)).toEqual(DEFAULT_TRANSITION)
    for (const kind of ['none', 'fade', 'push', 'cube', 'magic'] as const) {
      expect(SlideTransitionSchema.safeParse({ kind, durationMs: 400 }).success).toBe(true)
    }
    expect(
      SlideTransitionSchema.parse({ kind: 'push', durationMs: 500, direction: 'left' }),
    ).toEqual({ kind: 'push', durationMs: 500, direction: 'left' })
  })

  it('bounds the duration', () => {
    const path = (durationMs: number) =>
      SlideTransitionSchema.safeParse({ kind: 'fade', durationMs }).error?.issues[0]?.path
    expect(path(-1)).toEqual(['durationMs'])
    expect(path(MAX_TRANSITION_DURATION_MS + 1)).toEqual(['durationMs'])
    expect(path(MAX_TRANSITION_DURATION_MS)).toBeUndefined()
  })
})

describe('SlideBackgroundSchema', () => {
  it.each([
    DEFAULT_BACKGROUND,
    { kind: 'color', color: 0x101010 },
    {
      kind: 'linearGradient',
      angleDeg: 45,
      stops: [
        { offset: 0, color: 0xffffff },
        { offset: 1, color: 0x000000, alpha: 0.5 },
      ],
    },
    {
      kind: 'radialGradient',
      centerX: 0.5,
      centerY: 0.4,
      radius: 0.8,
      stops: [
        { offset: 0, color: 0xffffff },
        { offset: 1, color: 0x336699 },
      ],
    },
    { kind: 'image', assetId: 'bg-1', fit: 'cover', dim: 0.3 },
  ])('accepts %j', (bg) => {
    expect(SlideBackgroundSchema.parse(bg)).toEqual(bg)
  })

  it('rejects out-of-range values with paths', () => {
    const issues = (bg: unknown) =>
      SlideBackgroundSchema.safeParse(bg).error?.issues.map((i) => i.path)
    expect(issues({ kind: 'color', color: 0xffffff, alpha: 2 })).toEqual([['alpha']])
    expect(issues({ kind: 'image', assetId: 'bg', fit: 'fill' })).toEqual([['fit']])
    expect(
      issues({
        kind: 'radialGradient',
        centerX: 1.5,
        centerY: 0.5,
        radius: 1,
        stops: [{ offset: 0, color: 0 }],
      }),
    ).toEqual([['centerX'], ['stops']])
  })

  it('stores ints only; the input variant accepts hex', () => {
    const hexBg = { kind: 'color', color: '#00f' }
    expect(SlideBackgroundSchema.safeParse(hexBg).success).toBe(false)
    expect(SlideBackgroundInputSchema.parse(hexBg)).toEqual({ kind: 'color', color: 0x0000ff })
  })
})

describe('DeckGuideSchema', () => {
  it('validates a guide', () => {
    expect(DeckGuideSchema.parse({ id: 'g', orientation: 'vertical', position: 960 })).toEqual({
      id: 'g',
      orientation: 'vertical',
      position: 960,
    })
    expect(
      DeckGuideSchema.safeParse({ id: 'g', orientation: 'diagonal', position: 0 }).success,
    ).toBe(false)
  })
})
