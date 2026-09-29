import { describe, expect, it } from 'vitest'
import { polygonSides, regularPolygonVertices, triangleVertices } from './shapeGeometry.js'

describe('shapeGeometry', () => {
  it("fills the box with a triangle, like PowerPoint's triangle preset", () => {
    expect(triangleVertices(300, 200)).toEqual([
      { x: 150, y: 0 },
      { x: 300, y: 200 },
      { x: 0, y: 200 },
    ])
  })

  it('inscribes a regular polygon in the box ellipse, first vertex at the top, clockwise', () => {
    const hexagon = regularPolygonVertices(6, 200, 100)
    expect(hexagon).toHaveLength(6)
    expect(hexagon[0]!.x).toBeCloseTo(100, 9)
    expect(hexagon[0]!.y).toBeCloseTo(0, 9)
    // Clockwise on screen (y down): the second vertex is to the right of the first.
    expect(hexagon[1]!.x).toBeGreaterThan(100)
    for (const p of hexagon) {
      expect(((p.x - 100) / 100) ** 2 + ((p.y - 50) / 50) ** 2).toBeCloseTo(1, 9)
    }
  })

  it('clamps a side count the way the renderers do', () => {
    expect(polygonSides(undefined)).toBe(5)
    expect(polygonSides(2)).toBe(3)
    expect(polygonSides(6.4)).toBe(6)
    expect(polygonSides(40)).toBe(12)
  })
})
