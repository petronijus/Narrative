/**
 * renderer/objectRenderers/lineRenderer.ts
 *
 * Shared renderer for `line` and `arrow`. Endpoints live in p1/p2
 * relative to the object's (x, y). The AABB (width/height) tracks
 * the span of the endpoints so selection + hit testing reuse the
 * same container.x/y + pivot plumbing as the other shapes.
 *
 * Caps: none / round / square / arrow. Arrow cap is drawn as a
 * filled triangle aligned with the stroke direction. `arrow` type
 * defaults its `endCap` to 'arrow'.
 */

import { Container, Graphics } from 'pixi.js'
import type { Container as PixiContainer } from 'pixi.js'
import type { LineObject, ArrowObject, LineCap } from '@narrative/shared'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { strokeDashedPolyline } from '../strokeDashed.js'
import { applyFlip } from './applyFlip.js'
import { resolveColour } from '../colourResolver.js'

type LineLike = LineObject | ArrowObject

const GRAPHICS_TAG = Symbol('lineGraphics')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: PixiContainer): any => n

function getGraphics(n: PixiContainer): Graphics | undefined {
  return asAny(n)[GRAPHICS_TAG] as Graphics | undefined
}

function effectiveEndCap(data: LineLike): LineCap {
  if (data.endCap !== undefined) return data.endCap
  return data.type === 'arrow' ? 'arrow' : 'none'
}

function drawArrowhead(
  g: Graphics,
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  strokeWidth: number,
  color: number,
  alpha: number,
): void {
  const dx = tipX - fromX
  const dy = tipY - fromY
  const len = Math.hypot(dx, dy)
  if (len === 0) return
  const ux = dx / len
  const uy = dy / len
  const perpX = -uy
  const perpY = ux
  const arrowLen = Math.max(strokeWidth * 3, 10)
  const arrowHalfWidth = Math.max(strokeWidth * 1.8, 6)
  const baseX = tipX - ux * arrowLen
  const baseY = tipY - uy * arrowLen
  g.poly([
    tipX,
    tipY,
    baseX + perpX * arrowHalfWidth,
    baseY + perpY * arrowHalfWidth,
    baseX - perpX * arrowHalfWidth,
    baseY - perpY * arrowHalfWidth,
  ])
  g.fill({ color, alpha })
}

function drawLine(g: Graphics, data: LineLike): void {
  g.clear()
  const { p1, p2, strokeWidth } = data
  const stroke = resolveColour(data.stroke)
  const sa = data.strokeAlpha ?? 1
  const dash = data.dash === true
  if (dash) {
    strokeDashedPolyline(g, [p1, p2], false, { color: stroke, width: strokeWidth, alpha: sa })
  } else {
    g.moveTo(p1.x, p1.y)
    g.lineTo(p2.x, p2.y)
    g.stroke({
      color: stroke,
      alpha: sa,
      width: strokeWidth,
      cap:
        data.startCap === 'round' || data.endCap === 'round'
          ? 'round'
          : data.startCap === 'square' || data.endCap === 'square'
            ? 'square'
            : 'butt',
    })
  }
  // Arrow cap — filled triangle at the pointed endpoint.
  const endCap = effectiveEndCap(data)
  if (endCap === 'arrow') {
    drawArrowhead(g, p2.x, p2.y, p1.x, p1.y, strokeWidth, stroke, sa)
  }
  if (data.startCap === 'arrow') {
    drawArrowhead(g, p1.x, p1.y, p2.x, p2.y, strokeWidth, stroke, sa)
  }
}

function applyTransform(node: PixiContainer, data: LineLike): void {
  node.rotation = data.rotation
  node.alpha = data.opacity
  // Pivot at the object's AABB centre so Magic Move + rotation feel
  // consistent with the other shape types.
  node.pivot.set(data.width / 2, data.height / 2)
  node.x = data.x + data.width / 2
  node.y = data.y + data.height / 2
  applyFlip(node, data)
}

function makeRenderer<T extends LineLike>(type: T['type']) {
  return {
    type,
    mount(data: T): PixiContainer {
      const container = new Container()
      const g = new Graphics()
      drawLine(g, data)
      container.addChild(g)
      asAny(container)[GRAPHICS_TAG] = g
      applyTransform(container, data)
      applyFilterEffects(container, data.shadow, data.blur)
      return container
    },
    update(node: PixiContainer, prev: T, next: T): void {
      applyTransform(node, next)
      const redraw =
        prev.stroke !== next.stroke ||
        prev.strokeAlpha !== next.strokeAlpha ||
        prev.strokeWidth !== next.strokeWidth ||
        prev.p1.x !== next.p1.x ||
        prev.p1.y !== next.p1.y ||
        prev.p2.x !== next.p2.x ||
        prev.p2.y !== next.p2.y ||
        prev.startCap !== next.startCap ||
        prev.endCap !== next.endCap ||
        prev.dash !== next.dash
      if (redraw) {
        const g = getGraphics(node)
        if (g !== undefined) drawLine(g, next)
      }
      applyFilterEffects(node, next.shadow, next.blur)
    },
    /** The stroke (and its arrowheads) resolves a token colour: redraw it (index.ts). */
    repaintColours(node: PixiContainer, data: T): void {
      const g = getGraphics(node)
      if (g !== undefined) drawLine(g, data)
    },
    destroy(node: PixiContainer): void {
      const g = getGraphics(node)
      g?.destroy()
      destroyFilterEffects(node)
      node.destroy()
    },
  }
}

export const lineRenderer = makeRenderer<LineObject>('line')
export const arrowRenderer = makeRenderer<ArrowObject>('arrow')
