// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { paintRuns, type Paint2D } from './paint.js'
import { diffRasters } from './pixelDiff.js'
import { rasterSize, stretchKeyword, type GlyphRun, type TextRunLayout } from './runs.js'
import { transformText } from './textTransform.js'

describe('transformText', () => {
  it('upper- and lower-cases, including length-changing letters', () => {
    expect(transformText('straße', 'uppercase', ' ')).toBe('STRASSE')
    expect(transformText('ABC', 'lowercase', ' ')).toBe('abc')
  })

  it('capitalises the first letter of each word, with the context before the fragment', () => {
    expect(transformText("one two o'neil x-ray", 'capitalize', ' ')).toBe("One Two O'neil X-Ray")
    // A fragment that continues a word keeps its first letter.
    expect(transformText('word', 'capitalize', 'a')).toBe('word')
  })
})

describe('rasterSize', () => {
  it('is HTMLTextSystem’s: the padded size rounded up, then scaled and rounded up', () => {
    expect(rasterSize({ width: 100.2, height: 20, padding: 7 }, 1)).toEqual({
      width: 115,
      height: 34,
    })
    expect(rasterSize({ width: 100.2, height: 20, padding: 7 }, 1.5)).toEqual({
      width: 173,
      height: 51,
    })
  })

  it('names only the widths Canvas2D can spell', () => {
    expect(stretchKeyword(75)).toBe('condensed')
    expect(stretchKeyword(80)).toBeUndefined()
  })
})

describe('diffRasters', () => {
  const white = (n: number): number[] => Array.from({ length: n * 4 }, () => 255)
  const withInk = (px: number[], i: number, v: number): number[] => {
    const out = [...px]
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    return out
  }

  it('finds nothing between equal rasters', () => {
    const a = withInk(white(4), 1, 0)
    expect(diffRasters(a, a, 2, 2)).toMatchObject({ differing: 0, ratio: 0, max: 0, dx: 0 })
  })

  it('counts differing pixels and where the ink moved', () => {
    const a = withInk(white(4), 0, 0)
    const b = withInk(white(4), 1, 0)
    const d = diffRasters(a, b, 2, 2)
    expect(d.differing).toBe(2)
    expect(d.ratio).toBe(2)
    expect(d.dx).toBeCloseTo(1)
    expect(d.dy).toBeCloseTo(0)
  })
})

/** A 2D context that records what is drawn where. */
function recorder(): { ctx: Paint2D; calls: Array<[string, string, number, number]> } {
  const calls: Array<[string, string, number, number]> = []
  const ctx = {
    font: '',
    letterSpacing: '0px',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    setTransform: () => undefined,
    clearRect: () => undefined,
    measureText: (t: string) => ({ width: t.length * 10 }),
    fillText: (t: string, x: number, y: number) => calls.push(['fill', t, x, y]),
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
    size: 20,
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
  lines: [],
})

describe('paintRuns', () => {
  it('draws a run at its x on the baseline rounded to a whole CSS pixel', () => {
    const { ctx, calls } = recorder()
    paintRuns(ctx, layout([run({})]), 2)
    expect(calls).toEqual([['fill', 'ab cd', 5, 20]])
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
    paintRuns(ctx, layout([r]), 1)
    expect(calls).toEqual([
      ['fill', 'ab', 5, 20],
      ['fill', 'cd', 35, 20],
      ['fill', 'ef', 68.5, 20],
    ])
  })

  it('strokes under the fill and snaps an underline to whole pixels', () => {
    const { ctx, calls } = recorder()
    paintRuns(
      ctx,
      layout([
        run({
          stroke: { width: 2, color: 'blue' },
          underline: { offset: 2.6, thickness: 1.7, color: 'black' },
        }),
      ]),
      1,
    )
    expect(calls).toEqual([
      ['stroke', 'ab cd', 5, 20],
      ['fill', 'ab cd', 5, 20],
      ['rect', '50x2', 5, 22],
    ])
  })
})

describe('faceOf (SDF atlases per face)', () => {
  it('reads style, weight and family off a run’s font shorthand', async () => {
    const { faceOf } = await import('./sdfText.js')
    expect(faceOf({ font: 'italic 700 24px "Inter", Arial' })).toEqual({
      style: 'italic',
      weight: '700',
      family: '"Inter", Arial',
    })
    expect(faceOf({ font: 'oblique 14deg 400 12.5px Georgia' })).toEqual({
      style: 'oblique 14deg',
      weight: '400',
      family: 'Georgia',
    })
    expect(faceOf({ font: 'bogus' })).toBeNull()
  })
})
