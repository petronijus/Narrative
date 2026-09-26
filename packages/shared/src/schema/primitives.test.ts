import { describe, expect, it } from 'vitest'
import {
  ColorInputSchema,
  ColorValueSchema,
  FiniteNumberSchema,
  RgbInputSchema,
  TokenRefSchema,
} from './primitives.js'

describe('ColorInputSchema', () => {
  it.each([
    [0x336699, 0x336699],
    [0, 0],
    [0xffffff, 0xffffff],
    ['#336699', 0x336699],
    ['#AbCdEf', 0xabcdef],
    ['#f00', 0xff0000],
    ['#0Fa', 0x00ffaa],
  ])('parses %j to %d', (input, expected) => {
    expect(ColorInputSchema.parse(input)).toBe(expected)
  })

  it('passes a colour token ref through unchanged', () => {
    const ref = { $token: 'colors.abc1234567' }
    expect(ColorInputSchema.parse(ref)).toEqual(ref)
    expect(ColorInputSchema.parse({ $token: 'textStyles.x_Y-1' })).toEqual({
      $token: 'textStyles.x_Y-1',
    })
  })

  it.each([
    ['#ff00'],
    ['#ggg'],
    ['336699'],
    ['red'],
    [0x1000000],
    [-1],
    [1.5],
    [Number.NaN],
    [null],
    [{ $token: 'effectStyles.abc' }], // resolves to no colour
    [{ $token: 'colors.' }],
    [{ $token: 'colors.abc', extra: 1 }],
  ])('rejects %j', (input) => {
    expect(ColorInputSchema.safeParse(input).success).toBe(false)
  })

  it('names the expected formats when a hex string is malformed', () => {
    const r = ColorInputSchema.safeParse('#12345')
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('#RRGGBB')
  })
})

describe('RgbInputSchema', () => {
  it('accepts ints and hex, rejects token refs (these slots store a bare int)', () => {
    expect(RgbInputSchema.parse('#fff')).toBe(0xffffff)
    expect(RgbInputSchema.parse(0x123456)).toBe(0x123456)
    expect(RgbInputSchema.safeParse({ $token: 'colors.abc' }).success).toBe(false)
  })
})

describe('ColorValueSchema (storage)', () => {
  it('does not accept hex strings — storage holds ints only', () => {
    expect(ColorValueSchema.safeParse('#ffffff').success).toBe(false)
    expect(ColorValueSchema.parse(0xffffff)).toBe(0xffffff)
  })
})

describe('TokenRefSchema', () => {
  it('accepts every token category', () => {
    for (const cat of ['colors', 'textStyles', 'effectStyles']) {
      expect(TokenRefSchema.safeParse({ $token: `${cat}.abc1234567` }).success).toBe(true)
    }
    expect(TokenRefSchema.safeParse({ $token: 'fonts.abc' }).success).toBe(false)
  })
})

describe('FiniteNumberSchema', () => {
  it('rejects NaN and infinities', () => {
    expect(FiniteNumberSchema.safeParse(Number.NaN).success).toBe(false)
    expect(FiniteNumberSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
    expect(FiniteNumberSchema.safeParse(-1e9).success).toBe(true)
  })
})
