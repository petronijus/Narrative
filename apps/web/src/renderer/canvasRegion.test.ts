// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  backingFor,
  gridFraction,
  MAX_BACKING_PIXELS,
  regionAround,
  regionHolds,
  resolutionToHold,
} from './canvasRegion.js'

describe('backingFor', () => {
  it('is the viewport and a quarter each side, at the device pixel ratio', () => {
    expect(backingFor({ width: 1000, height: 600 }, 2)).toEqual({ width: 3000, height: 1800 })
  })
  it('keeps the margin within the pixel budget, and the viewport itself where it can', () => {
    const b = backingFor({ width: 7680, height: 2160 }, 1)
    expect(b.width * b.height).toBeLessThanOrEqual(MAX_BACKING_PIXELS + b.width + b.height)
    expect(b.width).toBeGreaterThanOrEqual(7680)
  })
})

describe('regionAround', () => {
  it('centres on the view with its corner on a whole device px', () => {
    const r = regionAround(
      { x: 100, y: 50, width: 400, height: 300 },
      { width: 1000, height: 900 },
      0.54,
    )
    expect(r.width).toBeCloseTo(1000 / 0.54)
    expect(Number.isInteger(Math.round(r.x * 0.54 * 1e9) / 1e9)).toBe(true)
    expect(regionHolds(r, { x: 100, y: 50, width: 400, height: 300 })).toBe(true)
  })
})

describe('resolutionToHold', () => {
  it('lowers the resolution until the store covers the view, never raises it', () => {
    const view = { x: 0, y: 0, width: 4000, height: 2000 }
    const res = resolutionToHold(view, { width: 2000, height: 1500 }, 1)
    expect(2000 / res).toBeGreaterThanOrEqual(4000)
    expect(
      resolutionToHold({ x: 0, y: 0, width: 10, height: 10 }, { width: 2000, height: 1500 }, 1),
    ).toBe(1)
  })
})

describe('gridFraction', () => {
  it('reads a fraction past float noise', () => {
    expect(gridFraction(57.99998)).toBe(0)
    expect(gridFraction(10.25)).toBe(0.25)
    expect(gridFraction(10.75)).toBe(-0.25)
    // A zoomed artboard's world origin: any fraction, not a LayoutUnit (item A).
    expect(Math.abs(gridFraction(-3968.1371867) - -0.1371867)).toBeLessThan(1 / 8192)
  })
})
