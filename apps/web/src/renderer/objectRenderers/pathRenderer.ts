/**
 * renderer/objectRenderers/pathRenderer.ts
 *
 * P4c: bezier path renderer. Each anchor's cpIn / cpOut drives cubic
 * segments; anchors without controls fall back to straight lines.
 * The object's (x, y, width, height) defines the AABB used for
 * selection + transforms, same pivot convention as the other shapes.
 */

import { Container, Graphics } from 'pixi.js'
import type { Container as PixiContainer } from 'pixi.js'
import type { PathObject, PathAnchor } from '@narrative/shared'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { applyFlip } from './applyFlip.js'

const GRAPHICS_TAG = Symbol('pathGraphics')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: PixiContainer): any => n

function getGraphics(n: PixiContainer): Graphics | undefined {
  return asAny(n)[GRAPHICS_TAG] as Graphics | undefined
}

function drawPath(g: Graphics, data: PathObject): void {
  g.clear()
  const anchors = data.anchors
  if (anchors.length === 0) return

  const first = anchors[0]!
  g.moveTo(first.x, first.y)

  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!
    const cur = anchors[i]!
    if (prev.cpOut !== undefined && cur.cpIn !== undefined) {
      g.bezierCurveTo(
        prev.x + prev.cpOut.x,
        prev.y + prev.cpOut.y,
        cur.x + cur.cpIn.x,
        cur.y + cur.cpIn.y,
        cur.x,
        cur.y,
      )
    } else {
      g.lineTo(cur.x, cur.y)
    }
  }

  if (data.closed === true) {
    const last = anchors[anchors.length - 1]!
    if (last.cpOut !== undefined && first.cpIn !== undefined) {
      g.bezierCurveTo(
        last.x + last.cpOut.x,
        last.y + last.cpOut.y,
        first.x + first.cpIn.x,
        first.y + first.cpIn.y,
        first.x,
        first.y,
      )
    } else {
      g.lineTo(first.x, first.y)
    }
    g.closePath()
    if (data.fill !== undefined) {
      g.fill({ color: data.fill, alpha: data.fillAlpha ?? 1 })
    }
  }

  g.stroke({
    color: data.stroke,
    alpha: data.strokeAlpha ?? 1,
    width: data.strokeWidth,
    cap: 'round',
    join: data.strokeJoin ?? 'round',
  })
}

function applyTransform(node: PixiContainer, data: PathObject): void {
  node.rotation = data.rotation
  node.alpha = data.opacity
  node.pivot.set(data.width / 2, data.height / 2)
  node.x = data.x + data.width / 2
  node.y = data.y + data.height / 2
  applyFlip(node, data)
}

function anchorsEqual(a: PathAnchor[], b: PathAnchor[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.x !== y.x || x.y !== y.y) return false
    if (JSON.stringify(x.cpIn) !== JSON.stringify(y.cpIn)) return false
    if (JSON.stringify(x.cpOut) !== JSON.stringify(y.cpOut)) return false
  }
  return true
}

export const pathRenderer = {
  type: 'path' as const,
  mount(data: PathObject): PixiContainer {
    const container = new Container()
    const g = new Graphics()
    drawPath(g, data)
    container.addChild(g)
    asAny(container)[GRAPHICS_TAG] = g
    applyTransform(container, data)
    applyFilterEffects(container, data.shadow, data.blur)
    return container
  },
  update(node: PixiContainer, prev: PathObject, next: PathObject): void {
    applyTransform(node, next)
    const redraw =
      prev.stroke !== next.stroke ||
      prev.strokeAlpha !== next.strokeAlpha ||
      prev.strokeWidth !== next.strokeWidth ||
      prev.fill !== next.fill ||
      prev.fillAlpha !== next.fillAlpha ||
      prev.closed !== next.closed ||
      prev.width !== next.width ||
      prev.height !== next.height ||
      !anchorsEqual(prev.anchors, next.anchors)
    if (redraw) {
      const g = getGraphics(node)
      if (g !== undefined) drawPath(g, next)
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
