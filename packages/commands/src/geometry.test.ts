import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  OPPOSITE_ANCHOR,
  anchorsOnSlide,
  drawnBounds,
  fitAnchors,
  frameCorners,
  shapeOutline,
  placeResized,
  resizeFromHandle,
  scaleCrop,
  visualBounds,
  type Anchor,
  type Frame,
  type PathPoint,
  type ResizeHandle,
} from './geometry.js'

/** Slide position of an anchor of a frame. */
function anchorPoint(frame: Frame, anchor: Anchor): { x: number; y: number } {
  const [tl, tr, br, bl] = frameCorners(frame) as [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ]
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  })
  const map: Record<Anchor, { x: number; y: number }> = {
    topLeft: tl,
    top: mid(tl, tr),
    topRight: tr,
    left: mid(tl, bl),
    center: mid(tl, br),
    right: mid(tr, br),
    bottomLeft: bl,
    bottom: mid(bl, br),
    bottomRight: br,
  }
  return map[anchor]
}

const tilted: Frame = { x: 100, y: 200, width: 300, height: 120, rotation: 0.6 }

describe('placeResized', () => {
  it.each(ANCHORS.map((a) => [a]))('keeps the %s anchor where it was, rotated or not', (anchor) => {
    for (const frame of [{ ...tilted, rotation: 0 }, tilted]) {
      const before = anchorPoint(frame, anchor)
      const box = { ...placeResized(frame, 520, 80, anchor), width: 520, height: 80 }
      const after = anchorPoint({ ...box, rotation: frame.rotation }, anchor)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })
})

describe('resizeFromHandle', () => {
  const handles: ResizeHandle[] = ['TL', 'TC', 'TR', 'ML', 'MR', 'BL', 'BC', 'BR']

  it.each(handles.map((h) => [h]))('the %s drag keeps the opposite handle put', (handle) => {
    for (const frame of [{ ...tilted, rotation: 0 }, tilted]) {
      const anchor = OPPOSITE_ANCHOR[handle]
      const before = anchorPoint(frame, anchor)
      const box = resizeFromHandle(frame, handle, 37, -22, false)
      const after = anchorPoint({ ...box, rotation: frame.rotation }, anchor)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })

  it('locks the aspect ratio on a corner, never on an edge', () => {
    const frame: Frame = { x: 0, y: 0, width: 200, height: 100, rotation: 0 }
    const corner = resizeFromHandle(frame, 'BR', 100, 10, true)
    expect(corner.width / corner.height).toBeCloseTo(2, 9)
    const edge = resizeFromHandle(frame, 'MR', 100, 10, true)
    expect(edge).toEqual({ x: 0, y: 0, width: 300, height: 100 })
  })

  it('never goes below 1 px a side', () => {
    const frame: Frame = { x: 0, y: 0, width: 50, height: 50, rotation: 0 }
    expect(resizeFromHandle(frame, 'BR', -500, -500, false)).toMatchObject({ width: 1, height: 1 })
  })
})

describe('scaleCrop', () => {
  it('scales and moves a crop with its frame', () => {
    const from = { x: 100, y: 100, width: 200, height: 100 }
    const to = { x: 50, y: 100, width: 400, height: 200 }
    expect(scaleCrop({ x: 80, y: 90, width: 300, height: 150 }, from, to)).toEqual({
      x: 10,
      y: 80,
      width: 600,
      height: 300,
    })
  })
})

describe('visualBounds', () => {
  it('is the box itself without rotation, and the rotated outline otherwise', () => {
    const box = { x: 10, y: 20, width: 100, height: 50 }
    expect(visualBounds({ ...box, rotation: 0 })).toEqual(box)
    const turned = visualBounds({ ...box, rotation: Math.PI / 2 })
    expect(turned.width).toBeCloseTo(50, 9)
    expect(turned.height).toBeCloseTo(100, 9)
    expect(turned.x + turned.width / 2).toBeCloseTo(60, 9)
  })
})

describe('fitAnchors', () => {
  const points: PathPoint[] = [
    { x: 400, y: 300, cpOut: { x: 60, y: -90 } },
    { x: 700, y: 520, cpIn: { x: -40, y: 10 }, moveTo: true },
    { x: 380, y: 610 },
  ]
  const turns = [
    { rotation: 0 },
    { rotation: 0.9 },
    { rotation: -2.4, flipH: true },
    { rotation: 3.3, flipV: true },
    { rotation: 1.2, flipH: true, flipV: true },
  ]

  it.each(turns.map((t) => [t]))('is undone by anchorsOnSlide for %o', (turn) => {
    const { box, anchors } = fitAnchors(points, turn)
    const drawn = anchorsOnSlide({ ...box, ...turn }, anchors)
    drawn.forEach((a, i) => {
      const p = points[i]!
      expect(a.x).toBeCloseTo(p.x, 9)
      expect(a.y).toBeCloseTo(p.y, 9)
      expect(a.moveTo).toBe(p.moveTo)
      for (const k of ['cpIn', 'cpOut'] as const) {
        if (p[k] === undefined) continue
        expect(a[k]!.x).toBeCloseTo(p[k]!.x, 9)
        expect(a[k]!.y).toBeCloseTo(p[k]!.y, 9)
      }
    })
    // The local anchors start at the box's top-left.
    expect(Math.min(...anchors.map((a) => a.x))).toBeGreaterThanOrEqual(-1e-9)
  })

  it('bounds the anchors when no segment curves (a moveTo splits the handles apart)', () => {
    expect(fitAnchors(points, { rotation: 0 }).box).toEqual({
      x: 380,
      y: 300,
      width: 320,
      height: 310,
    })
  })
})

describe('drawnBounds', () => {
  /** Dense sampling of one cubic, for comparison. */
  function sampled(p0: PathPoint, p3: PathPoint): { minY: number; maxY: number } {
    const c1 = { x: p0.x + p0.cpOut!.x, y: p0.y + p0.cpOut!.y }
    const c2 = { x: p3.x + p3.cpIn!.x, y: p3.y + p3.cpIn!.y }
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i <= 10_000; i++) {
      const t = i / 10_000
      const u = 1 - t
      const y = u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    return { minY, maxY }
  }

  it('is the curve itself, not its handles', () => {
    const s: PathPoint[] = [
      { x: 300, y: 700, cpOut: { x: 150, y: -200 } },
      { x: 700, y: 700, cpIn: { x: -150, y: 200 } },
    ]
    const box = drawnBounds(s, false)
    const { minY, maxY } = sampled(s[0]!, s[1]!)
    expect(box.x).toBe(300)
    expect(box.width).toBe(400)
    expect(box.y).toBeCloseTo(minY, 4)
    expect(box.y + box.height).toBeCloseTo(maxY, 4)
    // 200 / sqrt(3): the handles reach 200 px each way, the curve far less.
    expect(box.height).toBeCloseTo(200 / Math.sqrt(3), 9)
  })

  it('ignores a handle no segment uses, and follows the closing segment of a closed path', () => {
    const open: PathPoint[] = [
      { x: 0, y: 0, cpIn: { x: 0, y: -500 } },
      { x: 100, y: 0 },
      { x: 100, y: 100, cpOut: { x: 0, y: 500 } },
    ]
    expect(drawnBounds(open, false)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    // Closed, the last anchor's cpOut and the first's cpIn make the closing
    // segment a curve bulging below.
    expect(drawnBounds(open, true).height).toBeGreaterThan(100)
  })
})

describe('shapeOutline', () => {
  it('traces a sharp rectangle, a triangle and an upward polygon clockwise', () => {
    expect(shapeOutline({ type: 'rectangle' }, 200, 100)).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ])
    expect(shapeOutline({ type: 'triangle' }, 100, 80)[0]!.x).toBeCloseTo(50, 9)
    const hexagon = shapeOutline({ type: 'polygon', sides: 6 }, 100, 100)
    expect(hexagon).toHaveLength(6)
    expect(hexagon[0]!.x).toBeCloseTo(50, 9)
    expect(hexagon[0]!.y).toBeCloseTo(0, 9)
  })

  it("traces a triangle filling its box, like PowerPoint's triangle preset", () => {
    expect(shapeOutline({ type: 'triangle' }, 300, 200)).toEqual([
      { x: 150, y: 0 },
      { x: 300, y: 200 },
      { x: 0, y: 200 },
    ])
  })

  it('puts a rounded corner on the circle it rounds with', () => {
    const [start, end] = shapeOutline({ type: 'rectangle', cornerRadius: 20 }, 200, 100) as [
      PathPoint,
      PathPoint,
    ]
    expect(start).toMatchObject({ x: 0, y: 20 })
    expect(end).toMatchObject({ x: 20, y: 0 })
    // Handles point along the edges towards the corner.
    expect(start.cpOut!.x).toBeCloseTo(0, 9)
    expect(start.cpOut!.y).toBeLessThan(0)
    expect(end.cpIn!.x).toBeLessThan(0)
  })
})
