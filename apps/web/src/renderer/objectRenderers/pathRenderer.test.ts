/**
 * objectRenderers/pathRenderer.test.ts
 *
 * Unit tests for pathRenderer focussed on subpath / hole handling.
 *
 * These tests run real `pixi.js` (Graphics, GraphicsContext,
 * GraphicsPath, ShapePath) under jsdom — none of the path / shape
 * primitive code touches the GPU, so it works without a canvas
 * surface. We exercise the renderer end-to-end and then introspect
 * the resulting `fill` instruction's `GraphicsPath.shapePath` to
 * verify the multi-subpath handling:
 *
 *   1. letterform-badge case: 5 closed subpaths, all inner subpaths
 *      contained in the outer one. Pixi's `addPath` hole detection
 *      must move the 4 inner subpaths into the outer's `holes` array
 *      so they triangulate as cut-outs (not as overdrawn solid
 *      shapes with the same fill).
 *
 *   2. Dot-grid case: many small closed subpaths, none contained in
 *      another. Bounds-rejection in `containsPolygon` must keep them
 *      as independent shape primitives — no false-positive holes.
 *
 *   3. Open path: no fill instruction emitted; the renderer must drop
 *      the procedural-fill caches.
 */

import { describe, it, expect } from 'vitest'
import type { PathObject } from '@narrative/shared'
import { Graphics, GraphicsContext, GraphicsPath } from 'pixi.js'
import { pathRenderer } from './pathRenderer.js'

interface ShapePrimitive {
  shape: { type: string; points?: number[] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi internal
  holes?: any[]
}

function getFillPath(g: Graphics): GraphicsPath | undefined {
  const ctx = g.context as GraphicsContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi internal instruction list
  const instructions = (ctx as any).instructions as Array<{
    action: string
    data: { path: GraphicsPath }
  }>
  const fill = instructions.find((i) => i.action === 'fill')
  return fill?.data.path
}

function basePath(overrides: Partial<PathObject> = {}): PathObject {
  return {
    id: 'p',
    type: 'path',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    closed: true,
    anchors: [],
    fill: 0x000000,
    fillAlpha: 1,
    stroke: 0x000000,
    strokeAlpha: 1,
    strokeWidth: 0,
    ...overrides,
  } as PathObject
}

describe('pathRenderer subpath handling', () => {
  it('letterform-badge: inner subpaths become holes in the outer subpath', () => {
    // Outer subpath: full bounding square (0,0)..(100,100).
    // Inner subpath 1: small square (20,20)..(40,40) — contained.
    // Inner subpath 2: small square (60,60)..(80,80) — contained.
    const anchors: PathObject['anchors'] = [
      // outer
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      // inner 1
      { x: 20, y: 20, moveTo: true },
      { x: 40, y: 20 },
      { x: 40, y: 40 },
      { x: 20, y: 40 },
      // inner 2
      { x: 60, y: 60, moveTo: true },
      { x: 80, y: 60 },
      { x: 80, y: 80 },
      { x: 60, y: 80 },
    ]
    const node = pathRenderer.mount(basePath({ anchors }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal symbol-keyed Graphics ref
    const g = (node as any)[
      Object.getOwnPropertySymbols(node).find((s) => s.description === 'pathGraphics')!
    ] as Graphics
    const fillPath = getFillPath(g)
    expect(fillPath).toBeDefined()
    // NOTE: the `fill` instruction's GraphicsPath is `_activePath.clone()`
    // — a wrapper whose only instruction is `addPath(ourPath)`. Hole
    // detection runs when `_activePath.shapePath` is built (inside the
    // wrapper's ShapePath.addPath), not on the wrapper itself, so we
    // assert the resulting shapePrimitives directly.
    const primitives = fillPath!.shapePath.shapePrimitives as ShapePrimitive[]
    // After hole detection the 2 inner subpaths fold into the outer's
    // `holes` array, so we should be left with ONE primitive carrying
    // 2 holes.
    expect(primitives.length).toBe(1)
    expect(primitives[0]!.holes).toBeDefined()
    expect(primitives[0]!.holes!.length).toBe(2)
  })

  it('dot-grid: disjoint closed subpaths stay as separate primitives with no holes', () => {
    // Two small squares far apart — neither contains the other.
    const anchors: PathObject['anchors'] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 5 },
      { x: 50, y: 50, moveTo: true },
      { x: 55, y: 50 },
      { x: 55, y: 55 },
      { x: 50, y: 55 },
    ]
    const node = pathRenderer.mount(basePath({ anchors }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal symbol-keyed Graphics ref
    const g = (node as any)[
      Object.getOwnPropertySymbols(node).find((s) => s.description === 'pathGraphics')!
    ] as Graphics
    const fillPath = getFillPath(g)
    expect(fillPath).toBeDefined()

    const primitives = fillPath!.shapePath.shapePrimitives as ShapePrimitive[]
    expect(primitives.length).toBe(2)
    for (const p of primitives) {
      expect(p.holes ?? []).toEqual([])
    }
  })

  it('open path with strokeWidth > 0 emits a stroke instruction but no fill', () => {
    const anchors: PathObject['anchors'] = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ]
    const node = pathRenderer.mount(
      basePath({ anchors, closed: false, strokeWidth: 2, fill: 0xff0000 }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal symbol-keyed Graphics ref
    const g = (node as any)[
      Object.getOwnPropertySymbols(node).find((s) => s.description === 'pathGraphics')!
    ] as Graphics
    const ctx = g.context as GraphicsContext
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi internal instruction list
    const instructions = (ctx as any).instructions as Array<{ action: string }>
    expect(instructions.find((i) => i.action === 'fill')).toBeUndefined()
    expect(instructions.find((i) => i.action === 'stroke')).toBeDefined()
  })
})
