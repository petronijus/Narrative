/**
 * renderer/objectRenderers/polygonRenderer.ts
 *
 * Shared renderer for `triangle` and `polygon`. Both are regular
 * equilateral shapes inscribed in the object's AABB. Triangle is
 * fixed to 3 sides; polygon accepts a `sides` field (clamped to
 * [3, 12]) so a 5-gon, hexagon, etc. use the same code path.
 *
 * Pivot is at the centre of the AABB so rotation / Magic Move
 * behaves like Rectangle / Ellipse.
 */

import { Container, Graphics } from 'pixi.js'
import type { Container as PixiContainer } from 'pixi.js'
import type { TriangleObject, PolygonObject } from '@narrative/shared'
import { fillStyleToPixi } from '../fillStyleToPixi.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { strokeDashedPolyline } from '../strokeDashed.js'

type PolygonLike = TriangleObject | PolygonObject

const GRAPHICS_TAG = Symbol('polyGraphics')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: PixiContainer): any => n

function getGraphics(n: PixiContainer): Graphics | undefined {
  return asAny(n)[GRAPHICS_TAG] as Graphics | undefined
}

function sidesFor(data: PolygonLike): number {
  if (data.type === 'triangle') return 3
  return Math.max(3, Math.min(12, Math.round(data.sides ?? 5)))
}

function drawPolygon(g: Graphics, data: PolygonLike): void {
  g.clear()
  const n = sidesFor(data)
  const cx = data.width / 2
  const cy = data.height / 2
  const rx = data.width / 2
  const ry = data.height / 2
  // Top-pointing: start at −90 degrees (= top), step 360/n around the centre.
  const start = -Math.PI / 2
  const points: number[] = []
  for (let i = 0; i < n; i++) {
    const angle = start + (i * 2 * Math.PI) / n
    points.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle))
  }
  g.poly(points)
  const resolved = fillStyleToPixi(data.fillStyle, data.fill, data.width, data.height)
  g.fill(resolved.input)
  if (data.stroke !== undefined && (data.strokeWidth ?? 0) > 0) {
    const w = data.strokeWidth ?? 1
    if (data.strokeDash === true) {
      const pts: Array<{ x: number; y: number }> = []
      for (let i = 0; i < points.length; i += 2) {
        pts.push({ x: points[i]!, y: points[i + 1]! })
      }
      strokeDashedPolyline(g, pts, true, { color: data.stroke, width: w })
    } else {
      g.poly(points)
      g.stroke({ color: data.stroke, width: w, alignment: 0.5 })
    }
  }
}

function applyTransform(node: PixiContainer, data: PolygonLike): void {
  node.rotation = data.rotation
  node.alpha = data.opacity
  node.pivot.set(data.width / 2, data.height / 2)
  node.x = data.x + data.width / 2
  node.y = data.y + data.height / 2
}

function makeRenderer<T extends PolygonLike>(type: T['type']) {
  return {
    type,
    mount(data: T): PixiContainer {
      const container = new Container()
      const g = new Graphics()
      drawPolygon(g, data)
      container.addChild(g)
      asAny(container)[GRAPHICS_TAG] = g
      applyTransform(container, data)
      applyFilterEffects(container, data.shadow, data.blur)
      return container
    },
    update(node: PixiContainer, prev: T, next: T): void {
      applyTransform(node, next)
      const prevSides = sidesFor(prev)
      const nextSides = sidesFor(next)
      const redraw =
        prev.fill !== next.fill ||
        prev.width !== next.width ||
        prev.height !== next.height ||
        prevSides !== nextSides ||
        prev.stroke !== next.stroke ||
        prev.strokeWidth !== next.strokeWidth ||
        prev.strokeDash !== next.strokeDash ||
        prev.fillStyle !== next.fillStyle
      if (redraw) {
        const g = getGraphics(node)
        if (g !== undefined) drawPolygon(g, next)
      }
      applyFilterEffects(node, next.shadow, next.blur)
    },
    destroy(node: PixiContainer): void {
      const g = getGraphics(node)
      g?.destroy()
      destroyFilterEffects(node)
      node.destroy()
    },
  }
}

export const triangleRenderer = makeRenderer<TriangleObject>('triangle')
export const polygonRenderer = makeRenderer<PolygonObject>('polygon')
