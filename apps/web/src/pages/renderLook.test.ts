import { describe, expect, it } from 'vitest'
import { clampRegion, fitScale, SHEET_GAP, sheetLayout } from './renderLook'

describe('clampRegion', () => {
  it('keeps a region inside the slide, in whole pixels, never empty', () => {
    expect(clampRegion({ x: 100.4, y: 50.6, width: 200.2, height: 99.1 })).toEqual({
      x: 100,
      y: 50,
      width: 201,
      height: 100,
    })
    expect(clampRegion({ x: -50, y: -50, width: 3000, height: 3000 })).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
    expect(clampRegion({ x: 5000, y: 5000, width: 10, height: 0 })).toEqual({
      x: 1919,
      y: 1079,
      width: 1,
      height: 1,
    })
  })
})

describe('fitScale', () => {
  it('fits the long edge and the pixel count, never enlarging', () => {
    const s = fitScale(1920, 1080, 1568, 1_150_000)
    expect(Math.round(1920 * s)).toBe(1430)
    expect(Math.round(1080 * s)).toBe(804)
    expect(fitScale(300, 200, 1568, 1_150_000)).toBe(1)
  })
})

describe('sheetLayout', () => {
  it('picks the grid with the largest tiles inside the limits', () => {
    for (const count of [1, 2, 4, 9, 12, 20]) {
      const l = sheetLayout(count, 1568, 1_150_000)
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(count)
      const w = l.cols * l.tileWidth + SHEET_GAP * (l.cols + 1)
      const h = l.rows * l.tileHeight + SHEET_GAP * (l.rows + 1)
      expect(Math.max(w, h)).toBeLessThanOrEqual(1568)
      expect(w * h).toBeLessThanOrEqual(1_150_000)
    }
    expect(sheetLayout(4, 1568, 1_150_000)).toMatchObject({ cols: 2, rows: 2 })
    // A tall 2 × 6 allows the same tile as 3 × 4; the wider one wins.
    expect(sheetLayout(12, 1568, 1_150_000)).toMatchObject({ cols: 3, rows: 4 })
    expect(sheetLayout(20, 1568, 1_150_000)).toMatchObject({ cols: 4, rows: 5, tileWidth: 306 })
    expect(sheetLayout(1, 1568, 1_150_000).cols).toBe(1)
  })
})
