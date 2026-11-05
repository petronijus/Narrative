// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compareInkPlacement, inkOf, type InkMap } from './inkCentres.js'

/** A 120 × 60 map with two "lines" of two "words" each, shifted by (dx, dy), at `weight`. */
function words(dx: number, dy: number, weight = 255, bold = 0): InkMap {
  const width = 120
  const height = 60
  const ink = new Float32Array(width * height)
  const box = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y++)
      for (let x = x0 - bold; x < x1 + bold; x++) ink[(y + dy) * width + x + dx] = weight
  }
  box(10, 10, 40, 20)
  box(50, 10, 90, 20)
  box(10, 34, 30, 44)
  box(42, 34, 100, 44)
  return { width, height, ink }
}

describe('compareInkPlacement', () => {
  it('reports nothing moved for the same picture, whatever its darkness', () => {
    const r = compareInkPlacement(words(0, 0), words(0, 0, 140))
    expect(r.lines).toBe(2)
    expect(r.linesOther).toBe(2)
    expect(r.lineDx).toBe(0)
    expect(r.lineDy).toBe(0)
    expect(r.wordDx).toBe(0)
    expect(r.coverage).toBeCloseTo(140 / 255)
  })

  it('ignores ink grown evenly on both sides of every stroke (heavier smoothing)', () => {
    const r = compareInkPlacement(words(0, 0), words(0, 0, 255, 1))
    // A word's centre stays, and a line's height; a line's x centre moves
    // (0.6 px here), its words' weights changing in proportion to their
    // widths — so position gates read words along x, lines along y.
    expect(r.wordDx).toBeLessThan(0.01)
    expect(r.lineDy).toBeLessThan(0.01)
    expect(r.lineDx).toBeGreaterThan(0.3)
  })

  it('measures a shift', () => {
    const r = compareInkPlacement(words(0, 0), words(1, 1))
    expect(r.lineDx).toBeCloseTo(1)
    expect(r.lineDy).toBeCloseTo(1)
    expect(r.wordDx).toBeCloseTo(1)
  })
})

describe('inkOf', () => {
  it('reads alpha, or the distance from a background scaled to full ink', () => {
    const rgba = new Uint8Array([0, 0, 0, 128, 245, 245, 245, 255])
    expect([...inkOf(rgba, 2, 1).ink]).toEqual([128, 255])
    const overGrey = inkOf(rgba, 2, 1, [245, 245, 245])
    expect(overGrey.ink[0]).toBeCloseTo(255)
    expect(overGrey.ink[1]).toBe(0)
  })
})
