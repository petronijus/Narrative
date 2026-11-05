// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { apply, multiply, pageSpace, type Affine } from './pagePlacement.js'

const quarter: Affine = [0, 1, -1, 0, 0, 0]

describe('pageSpace', () => {
  it('leaves an untransformed box in the page: positions carry its offset', () => {
    const s = pageSpace(
      { origin: { x: 660.3, y: 60.7 }, rig: null, centre: { x: 260, y: 60 }, scale: 1 },
      'webkit',
      1,
    )
    expect(s.toPage).toEqual([1, 0, 0, 1, 0, 0])
    expect(s.offset.x).toBeCloseTo(660.296875, 9) // a LayoutUnit
    expect(s.offset.y).toBeCloseTo(60.703125, 9)
    expect(s.unit).toBe(1)
  })

  it('WebKit: snaps a turned layer to a device px and paints the rest inside the turn', () => {
    const s = pageSpace(
      { origin: { x: 1340.25, y: 300.5 }, rig: quarter, centre: { x: 260, y: 60 }, scale: 1 },
      'webkit',
      1,
    )
    // round(300.5) = 301 (halves up); 0.25 and −0.5 are left inside the layer.
    expect(s.offset).toEqual({ x: 0.25, y: -0.5 })
    // The box's centre stays where the layer's snapped offset puts it.
    expect(apply(s.toPage, { x: 260, y: 60 })).toEqual({ x: 1600, y: 361 })
  })

  it('WebKit at DPR 2: snaps to half px; the subpixel offset goes on into a scaled frame', () => {
    const s = pageSpace(
      { origin: { x: 100.3, y: 50.8 }, rig: quarter, centre: { x: 10, y: 10 }, scale: 0.5 },
      'webkit',
      2,
    )
    expect(s.unit).toBe(2)
    // Rig: 100.296875 → 100.5 (−0.203125), 50.796875 → 51 (−0.203125); the frame
    // at (0, 0) of the rig takes that offset: rounded to 0 at half px, kept inside.
    expect(s.offset.x).toBeCloseTo(-0.203125, 9)
    expect(s.offset.y).toBeCloseTo(-0.203125, 9)
    const m = multiply(s.toPage, [1, 0, 0, 1, 0, 0])
    expect(m[0]).toBeCloseTo(0, 12)
    expect(m[1]).toBeCloseTo(0.5, 12)
  })

  it('Blink: rounds a transformed layer to a whole px and drops the fraction', () => {
    const s = pageSpace(
      { origin: { x: 200.3, y: 300.5 }, rig: quarter, centre: { x: 260, y: 60 }, scale: 0.75 },
      'blink',
      2,
    )
    expect(s.offset).toEqual({ x: 0, y: 0 })
    expect(s.unit).toBe(1)
    // The rig at (200, 301), the frame scaled at the rig's corner.
    expect(apply(s.toPage, { x: 0, y: 0 })).toEqual(
      apply(multiply([1, 0, 0, 1, 200 + 260 + 60, 301 + 60 - 260], quarter), { x: 0, y: 0 }),
    )
  })
})
