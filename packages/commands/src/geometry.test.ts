import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  OPPOSITE_ANCHOR,
  frameCorners,
  placeResized,
  resizeFromHandle,
  scaleCrop,
  visualBounds,
  type Anchor,
  type Frame,
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
