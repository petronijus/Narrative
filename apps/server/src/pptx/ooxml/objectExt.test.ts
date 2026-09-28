import { describe, expect, it } from 'vitest'
import type { ArrowObject } from '@narrative/shared'
import { connectorFrame, objectExtValues } from './objectExt.js'

const arrow = (extra: Partial<ArrowObject> = {}): ArrowObject => ({
  id: 'a1',
  type: 'arrow',
  x: 100,
  y: 200,
  width: 300,
  height: 120,
  rotation: 0,
  opacity: 1,
  p1: { x: 0, y: 0 },
  p2: { x: 300, y: 120 },
  stroke: 0x224488,
  strokeWidth: 3,
  ...extra,
})

describe('connectorFrame', () => {
  it('runs top-left to bottom-right unflipped, and names a reversed direction with flips', () => {
    expect(connectorFrame(arrow())).toEqual({
      x: 100,
      y: 200,
      width: 300,
      height: 120,
      flipH: false,
      flipV: false,
    })
    expect(connectorFrame(arrow({ p1: { x: 300, y: 0 }, p2: { x: 0, y: 120 } }))).toMatchObject({
      flipH: true,
      flipV: false,
    })
  })

  it('writes a mirrored line the way it is drawn, and keeps its own ends in the extension', () => {
    // flipH mirrors the drawn line across its box: 0,0 → 300,120 is drawn
    // from 300,0 to 0,120 — a right-to-left connector for PowerPoint.
    const mirrored = arrow({ flipH: true })
    expect(connectorFrame(mirrored)).toMatchObject({ x: 100, y: 200, flipH: true, flipV: false })
    const ext = objectExtValues(mirrored, '') as Record<string, unknown>
    expect(ext['flipH']).toBe(true)
    expect(ext['box']).toEqual({
      x: 100,
      y: 200,
      width: 300,
      height: 120,
      p1: { x: 0, y: 0 },
      p2: { x: 300, y: 120 },
    })
  })
})
