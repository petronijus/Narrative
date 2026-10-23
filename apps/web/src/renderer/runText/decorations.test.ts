// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chromiumUnderline, fadeColor, subtract, webkitUnderline } from './decorations.js'

describe('chromiumUnderline (Blink 156)', () => {
  it('is a tenth of the size thick, an integer gap below the rounded ascent, painted snapped', () => {
    // 24 px: thickness 2.4, gap ⌈1.2⌉ = 2, offset 22 + 2 = 24 from the text's top.
    const g = chromiumUnderline({ top: 10.25, fontSize: 24, ascent: 22 }, 21.72)
    expect(g.thickness).toBeCloseTo(2.4)
    expect(g.lineY).toBeCloseTo(34.25)
    expect(g.paintY).toBe(34)
    expect(g.paintH).toBe(2)
    // Ink band: the line inset by ½, against the unrounded ascent's baseline.
    expect(g.inkTop).toBeCloseTo(34.75 - 31.97)
    expect(g.inkBottom - g.inkTop).toBeCloseTo(1.4)
    expect(g.dilation).toBeCloseTo(2.4)
  })

  it('is at least 1 px thick with a 1 px gap, and caps the ink dilation at 13', () => {
    const small = chromiumUnderline({ top: 0, fontSize: 8, ascent: 7 }, 7.2)
    expect(small.thickness).toBe(1)
    expect(small.lineY).toBe(8)
    expect(small.inkBottom).toBe(small.inkTop)
    expect(chromiumUnderline({ top: 0, fontSize: 300, ascent: 270 }, 270).dilation).toBe(13)
  })
})

describe('webkitUnderline', () => {
  it('is a sixteenth of the size thick, its top rounded up to a device px', () => {
    const g = webkitUnderline({ x: 10.4, top: 5.3, fontSize: 24 }, 21.7, 1.5)
    // gap ⌈24 / 16 / 2⌉ = 1; origin (10, round(28.0) = 28); device top ⌈42⌉ = 42.
    expect(g.h).toBeCloseTo(1.5)
    expect(g.x).toBeCloseTo(10)
    expect(g.y).toBeCloseTo(28)
  })
})

describe('subtract', () => {
  it('cuts a span out of the line, leaving what is on either side', () => {
    expect(subtract([{ begin: 0, end: 100 }], 20, 30)).toEqual([
      { begin: 0, end: 20 },
      { begin: 30, end: 100 },
    ])
    expect(subtract([{ begin: 0, end: 100 }], -5, 10)).toEqual([{ begin: 10, end: 100 }])
    expect(subtract([{ begin: 0, end: 10 }], 20, 30)).toEqual([{ begin: 0, end: 10 }])
  })
})

describe('fadeColor', () => {
  it('multiplies the alpha of a computed colour', () => {
    expect(fadeColor('rgb(10, 20, 30)', 0.5)).toBe('rgba(10, 20, 30, 0.5)')
    expect(fadeColor('rgba(10, 20, 30, 0.5)', 0.5)).toBe('rgba(10, 20, 30, 0.25)')
  })
})
