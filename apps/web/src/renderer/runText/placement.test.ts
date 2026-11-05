import { describe, expect, it } from 'vitest'
import { placeLayout, roundCss, type TextRunLayout } from './glyphRuns.js'
import {
  gridShiftKeepsRaster,
  holdPlacementRepaints,
  pageGridFor,
  placementHeld,
  setPageOrigin,
  setProspectivePage,
  type RasterAt,
} from './placement.js'

const at = (x: number, y: number, box = { x: x + 10, y: y + 10, width: 300 }): RasterAt => ({
  x,
  y,
  scale: 1,
  frame: null,
  box,
})

const shifted = (a: RasterAt, dx: number, dy: number): RasterAt => ({
  ...a,
  x: a.x + dx,
  y: a.y + dy,
  box: a.box === null ? null : { ...a.box, x: a.box.x + dx, y: a.box.y + dy },
  frame: a.frame === null ? null : { x: a.frame.x + dx, y: a.frame.y + dy },
})

const layout: TextRunLayout = {
  width: 280,
  height: 90,
  padding: 4,
  runs: [
    {
      text: 'One line',
      x: 4,
      y: 31.37,
      font: '24px X',
      stretch: 100,
      color: '#000',
      letterSpacing: 0,
      width: 90,
    },
    {
      text: 'Another',
      x: 4,
      y: 61.71,
      font: '24px X',
      stretch: 100,
      color: '#000',
      letterSpacing: 0,
      width: 80,
    },
  ],
  decorations: [],
}

/** What the painter makes of a placed layout: each baseline's texel row (paintRuns rounds it in CSS px of the page). */
function texelRows(top: RasterAt, resolution: number, phase: number, unit: number): number[] {
  const placed = placeLayout(
    layout,
    top,
    resolution,
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    undefined,
    {
      x: phase,
      y: phase,
    },
    unit,
  )
  const place = placed.place!
  return placed.runs.map(
    (r) => roundCss(r.y, place.css.y, place.unit ?? 1) * resolution - place.device.y,
  )
}

describe('gridShiftKeepsRaster', () => {
  it('keeps a raster moved by whole device px, CSS px and LayoutUnits', () => {
    const a = at(110.3, 440.7)
    expect(gridShiftKeepsRaster(a, shifted(a, 200, -120), 1, 1)).toBe(true)
    // DPR 2 at 100 %: half a CSS px is a device px, and WebKit's page rounds to device px.
    expect(gridShiftKeepsRaster(a, shifted(a, 0.5, 1.5), 2, 2)).toBe(true)
  })

  it('paints again a move that is not whole on every grid the paint rounds to', () => {
    const a = at(110.3, 440.7)
    // A device px at 108 % (DPR 2, the fitted zoom): not a whole CSS px.
    expect(gridShiftKeepsRaster(a, shifted(a, 1 / 1.08, 0), 1.08, 1)).toBe(false)
    // Half a CSS px where Blink rounds baselines to whole CSS px.
    expect(gridShiftKeepsRaster(a, shifted(a, 0, 0.5), 2, 1)).toBe(false)
    // A whole CSS px, not a whole device px at 54 %.
    expect(gridShiftKeepsRaster(a, shifted(a, 1, 0), 0.54, 1)).toBe(false)
  })

  it('paints again when the text moved in its box, or the box changed', () => {
    const a = at(110, 440)
    const inBox = { ...shifted(a, 10, 0), box: a.box }
    expect(gridShiftKeepsRaster(a, inBox, 1, 1)).toBe(false)
    const wider = { ...shifted(a, 10, 0), box: { ...shifted(a, 10, 0).box!, width: 320 } }
    expect(gridShiftKeepsRaster(a, wider, 1, 1)).toBe(false)
    expect(gridShiftKeepsRaster(a, { ...shifted(a, 10, 0), scale: 0.5 }, 1, 1)).toBe(false)
  })

  it('agrees with the painter: a kept raster has its lines where a fresh one would', () => {
    for (const [res, unit, dy] of [
      [1, 1, 37],
      [2, 2, 18.5],
      [2, 1, 21],
      [1.5, 1, 2],
    ] as const) {
      const a = at(110.3, 440.77)
      const b = shifted(a, 0, dy)
      expect(gridShiftKeepsRaster(a, b, res, unit)).toBe(true)
      const before = texelRows(a, res, 0.25, unit)
      const after = texelRows(b, res, 0.25, unit)
      // The same rows of the raster: the raster itself moves by whole texels.
      expect(after.map((v) => Math.round(v * 1e6) / 1e6)).toEqual(
        before.map((v) => Math.round(v * 1e6) / 1e6),
      )
    }
  })
})

describe('holdPlacementRepaints', () => {
  it('is counted, and a release is idempotent', () => {
    const renderer = {}
    const a = holdPlacementRepaints(renderer)
    const b = holdPlacementRepaints(renderer)
    a()
    a()
    expect(placementHeld(renderer)).toBe(true)
    b()
    expect(placementHeld(renderer)).toBe(false)
  })
})

describe('pageGridFor', () => {
  it('the canvas’s page at its resolution, a prospective one at that one’s, else none', () => {
    const renderer = { resolution: 1 }
    const region = { x: -10, y: -20, width: 2400, height: 1350 }
    setPageOrigin(renderer, { x: 5, y: 5 }, { x: -0.3, y: 0.25 }, region)
    expect(pageGridFor(renderer, 1)).toEqual({
      resolution: 1,
      origin: { x: 5, y: 5 },
      phase: { x: -0.3, y: 0.25 },
      region,
    })
    // A text pinned to another resolution: not on a device grid.
    expect(pageGridFor(renderer, 2)).toBeNull()
    const prospective = {
      resolution: 2,
      origin: { x: 5, y: 5 },
      phase: { x: 0.4, y: -0.5 },
      region: { x: -10, y: -20, width: 2400, height: 1350 },
    }
    setProspectivePage(renderer, prospective)
    expect(pageGridFor(renderer, 2)).toEqual(prospective)
    expect(pageGridFor(renderer, 1.5)).toBeNull()
    // The canvas's own page wins at its resolution.
    expect(pageGridFor(renderer, 1)?.phase).toEqual({ x: -0.3, y: 0.25 })
    setProspectivePage(renderer, null)
    expect(pageGridFor(renderer, 2)).toBeNull()
  })
})
