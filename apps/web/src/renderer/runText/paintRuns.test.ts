// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { GlyphRun, TextRunLayout } from './glyphRuns.js'
import { paintRuns, UnpaintableRunError, type Paint2D } from './paintRuns.js'

/** A 2D context that records what is drawn where (and, like a canvas, ignores a font it cannot parse). */
function recorder(): { ctx: Paint2D; calls: Array<[string, string, number, number]> } {
  const calls: Array<[string, string, number, number]> = []
  let font = '10px sans-serif'
  const ctx = {
    get font() {
      return font
    },
    set font(v: string) {
      if (/\d+(\.\d+)?px/u.test(v)) font = v
    },
    letterSpacing: '0px',
    fontStretch: 'normal',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    direction: 'ltr',
    setTransform: () => undefined,
    clearRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (t: string, x: number, y: number) =>
      calls.push([ctx.direction === 'rtl' ? 'fill-rtl' : 'fill', t, x, y]),
    strokeText: (t: string, x: number, y: number) => calls.push(['stroke', t, x, y]),
    fillRect: (x: number, y: number, w: number, h: number) =>
      calls.push(['rect', `${w}x${h}`, x, y]),
  }
  return { ctx: ctx as unknown as Paint2D, calls }
}

function run(over: Partial<GlyphRun>): GlyphRun {
  return {
    text: 'ab cd',
    x: 5,
    y: 20.4,
    font: 'normal 400 20px Arial',
    stretch: 100,
    color: 'black',
    letterSpacing: 0,
    width: 50,
    ...over,
  }
}

const layout = (runs: GlyphRun[]): TextRunLayout => ({
  width: 100,
  height: 30,
  padding: 0,
  runs,
  decorations: [],
})

const snap = { snapBaseline: true, decorations: 'chromium' as const, strokeMiterLimit: 4 }

describe('paintRuns', () => {
  it('draws a run at its x on the baseline rounded to a whole CSS pixel', () => {
    const { ctx, calls } = recorder()
    paintRuns(ctx, layout([run({})]), 2, snap)
    expect(calls).toEqual([['fill', 'ab cd', 5, 20]])
  })

  it('keeps the baseline where an engine does not snap it', () => {
    const { ctx, calls } = recorder()
    paintRuns(ctx, layout([run({})]), 2, {
      snapBaseline: false,
      decorations: 'chromium',
      strokeMiterLimit: 4,
    })
    expect(calls).toEqual([['fill', 'ab cd', 5, 20.4]])
  })

  it('follows the shaper between words unless the layout disagrees by more than the snapping', () => {
    const { ctx, calls } = recorder()
    // "cd" is where the pen is (30) within 1/64: drawn at the pen; "ef" was
    // kerned by the layout (68.5 against a pen of 60): drawn where the layout put it.
    const r = run({
      text: 'ab cd ef',
      parts: [
        { text: 'ab', dx: 0 },
        { text: 'cd', dx: 30 + 1 / 64 },
        { text: 'ef', dx: 63.5 },
      ],
    })
    paintRuns(ctx, layout([r]), 1, snap)
    expect(calls).toEqual([
      ['fill', 'ab', 5, 20],
      ['fill', 'cd', 35, 20],
      ['fill', 'ef', 68.5, 20],
    ])
  })

  it('strokes under the fill', () => {
    const { ctx, calls } = recorder()
    paintRuns(ctx, layout([run({ stroke: { width: 2, color: 'blue' } })]), 1, snap)
    expect(calls).toEqual([
      ['stroke', 'ab cd', 5, 20],
      ['fill', 'ab cd', 5, 20],
    ])
  })

  it('draws a right-to-left run from its right edge', () => {
    const { ctx, calls } = recorder()
    paintRuns(ctx, layout([run({ text: 'abc', rtl: true, x: 10, width: 30 })]), 1, snap)
    expect(calls).toEqual([['fill-rtl', 'abc', 40, 20]])
  })

  it('places each grapheme itself where the canvas cannot space letters', () => {
    const { ctx, calls } = recorder()
    delete (ctx as unknown as { letterSpacing?: string }).letterSpacing
    paintRuns(ctx, layout([run({ text: 'ab c', letterSpacing: 2 })]), 1, snap)
    // a at 5; b after "a" (10) and one spacing; the space is skipped; c after "ab " (30) + 3 spacings.
    expect(calls).toEqual([
      ['fill', 'a', 5, 20],
      ['fill', 'b', 17, 20],
      ['fill', 'c', 41, 20],
    ])
  })

  it('refuses a run whose font the canvas cannot set, or a width it cannot spell', () => {
    expect(() => paintRuns(recorder().ctx, layout([run({ font: 'bogus' })]), 1, snap)).toThrow(
      UnpaintableRunError,
    )
    expect(() => paintRuns(recorder().ctx, layout([run({ stretch: 80 })]), 1, snap)).toThrow(
      UnpaintableRunError,
    )
  })
})
