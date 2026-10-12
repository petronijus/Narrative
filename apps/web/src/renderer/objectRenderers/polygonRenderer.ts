/**
 * renderer/objectRenderers/polygonRenderer.ts
 *
 * Shared renderer for `triangle` and `polygon`. The outline comes from
 * @narrative/shared's shapeGeometry: a triangle fills its box like
 * PowerPoint's `triangle` preset; a polygon is the regular n-gon (`sides`
 * clamped to [3, 12]) inscribed in the box's ellipse.
 *
 * Pivot is at the centre of the AABB so rotation / Magic Move
 * behaves like Rectangle / Ellipse.
 */

import { Container, Graphics } from 'pixi.js'
import type { Container as PixiContainer } from 'pixi.js'
import { polygonSides, regularPolygonVertices, triangleVertices } from '@narrative/shared'
import type { TriangleObject, PolygonObject } from '@narrative/shared'
import { fillStyleToPixi, imageFillToPixiFill, releaseProceduralFill } from '../fillStyleToPixi.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { strokeDashedPolyline } from '../strokeDashed.js'
import { ensureImageFill, releaseImageFill } from '../imageFillLoader.js'
import { applyFlip } from './applyFlip.js'
import { resolveAlpha, resolveColour } from '../colourResolver.js'

type PolygonLike = TriangleObject | PolygonObject

const GRAPHICS_TAG = Symbol('polyGraphics')
/**
 * P5c: cache the latest data on the container so the image-fill async
 * onReady callback can redraw with current props even if the original
 * `next` has been superseded by a later update/patch tick.
 */
const LATEST_DATA_TAG = Symbol('polyLatestData')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: PixiContainer): any => n

function getGraphics(n: PixiContainer): Graphics | undefined {
  return asAny(n)[GRAPHICS_TAG] as Graphics | undefined
}

function sidesFor(data: PolygonLike): number {
  if (data.type === 'triangle') return 3
  return polygonSides(data.sides)
}

function outlineOf(data: PolygonLike): number[] {
  const vertices =
    data.type === 'triangle'
      ? triangleVertices(data.width, data.height)
      : regularPolygonVertices(sidesFor(data), data.width, data.height)
  return vertices.flatMap((p) => [p.x, p.y])
}

function drawPolygon(g: Graphics, container: PixiContainer, data: PolygonLike): void {
  g.clear()
  const points = outlineOf(data)
  g.poly(points)
  if (data.fillStyle?.kind === 'image') {
    const texture = ensureImageFill(container, data.fillStyle, () => {
      const cachedData = asAny(container)[LATEST_DATA_TAG] as PolygonLike | undefined
      const cachedG = getGraphics(container)
      if (cachedData !== undefined && cachedG !== undefined)
        drawPolygon(cachedG, container, cachedData)
    })
    const fillColour = resolveColour(data.fill)
    if (texture !== null) {
      g.fill(imageFillToPixiFill(data.fillStyle, texture, data.width, data.height))
    } else {
      g.fill({ color: fillColour, alpha: (data.fillAlpha ?? 1) * resolveAlpha(data.fill) })
    }
  } else {
    releaseImageFill(container)
    const fillColour = resolveColour(data.fill)
    const resolved = fillStyleToPixi(data.fillStyle, fillColour, data.width, data.height, container)
    const fillInput =
      data.fillStyle === undefined
        ? { color: fillColour, alpha: (data.fillAlpha ?? 1) * resolveAlpha(data.fill) }
        : resolved.input
    g.fill(fillInput)
  }
  // Save latest data for async redraw in image-fill onReady.
  asAny(container)[LATEST_DATA_TAG] = data
  if (data.stroke !== undefined && (data.strokeWidth ?? 0) > 0) {
    const strokeColour = resolveColour(data.stroke)
    const w = data.strokeWidth ?? 1
    const sa = (data.strokeAlpha ?? 1) * resolveAlpha(data.stroke)
    if (data.strokeDash === true) {
      const pts: Array<{ x: number; y: number }> = []
      for (let i = 0; i < points.length; i += 2) {
        pts.push({ x: points[i]!, y: points[i + 1]! })
      }
      strokeDashedPolyline(g, pts, true, { color: strokeColour, width: w, alpha: sa })
    } else {
      g.poly(points)
      g.stroke({ color: strokeColour, width: w, alignment: 0.5, alpha: sa })
    }
  }
}

function applyTransform(node: PixiContainer, data: PolygonLike): void {
  node.rotation = data.rotation
  node.alpha = data.opacity
  node.pivot.set(data.width / 2, data.height / 2)
  node.x = data.x + data.width / 2
  node.y = data.y + data.height / 2
  applyFlip(node, data)
}

function makeRenderer<T extends PolygonLike>(type: T['type']) {
  return {
    type,
    mount(data: T): PixiContainer {
      const container = new Container()
      const g = new Graphics()
      asAny(container)[GRAPHICS_TAG] = g
      drawPolygon(g, container, data)
      container.addChild(g)
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
        prev.fillAlpha !== next.fillAlpha ||
        prev.width !== next.width ||
        prev.height !== next.height ||
        prevSides !== nextSides ||
        prev.stroke !== next.stroke ||
        prev.strokeAlpha !== next.strokeAlpha ||
        prev.strokeWidth !== next.strokeWidth ||
        prev.strokeDash !== next.strokeDash ||
        prev.fillStyle !== next.fillStyle
      if (redraw) {
        const g = getGraphics(node)
        if (g !== undefined) drawPolygon(g, node, next)
      }
      applyFilterEffects(node, next.shadow, next.blur)
    },
    /** Fill and stroke resolve token colours: redraw them (index.ts, repaintColours). */
    repaintColours(node: PixiContainer, data: T): void {
      const g = getGraphics(node)
      if (g !== undefined) drawPolygon(g, node, data)
    },
    destroy(node: PixiContainer): void {
      releaseImageFill(node)
      releaseProceduralFill(node)
      const g = getGraphics(node)
      g?.destroy()
      destroyFilterEffects(node)
      node.destroy()
    },
  }
}

export const triangleRenderer = makeRenderer<TriangleObject>('triangle')
export const polygonRenderer = makeRenderer<PolygonObject>('polygon')
