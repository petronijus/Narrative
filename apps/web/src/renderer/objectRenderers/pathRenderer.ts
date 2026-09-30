/**
 * renderer/objectRenderers/pathRenderer.ts
 *
 * P4c: bezier path renderer. Each anchor's cpIn / cpOut drives cubic
 * segments; anchors without controls fall back to straight lines.
 * The object's (x, y, width, height) defines the AABB used for
 * selection + transforms, same pivot convention as the other shapes.
 */

import { Container, Graphics, GraphicsPath } from 'pixi.js'
import type { Container as PixiContainer } from 'pixi.js'
import type { PathObject, PathAnchor } from '@narrative/shared'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { applyFlip } from './applyFlip.js'
import { fillStyleToPixi, imageFillToPixiFill, releaseProceduralFill } from '../fillStyleToPixi.js'
import { ensureImageFill, releaseImageFill } from '../imageFillLoader.js'
import { resolveColour } from '../colourResolver.js'

const GRAPHICS_TAG = Symbol('pathGraphics')
const LATEST_DATA_TAG = Symbol('pathLatestData')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (n: PixiContainer): any => n

function getGraphics(n: PixiContainer): Graphics | undefined {
  return asAny(n)[GRAPHICS_TAG] as Graphics | undefined
}

function buildPath(data: PathObject): GraphicsPath | null {
  const anchors = data.anchors
  if (anchors.length === 0) return null
  // Subpath-aware tracing. PPTX `<a:custGeom>` can pack many
  // disconnected closed subpaths into a single `<a:path>` (dot grids,
  // multi-island icons, badges with inner holes). Each subpath begins
  // at an anchor with `moveTo === true` (the very first anchor is
  // implicitly a moveTo even without the flag). On entering a new
  // subpath we close the previous one (if `data.closed` is true) and
  // emit GraphicsPath.moveTo instead of lineTo — otherwise the
  // renderer draws straight connectors between sub-shapes (the
  // "diagonal-shear" artefact).
  //
  // We build a `GraphicsPath` (not inline `g.moveTo`/`g.lineTo`/...)
  // with `checkForHoles = true` so Pixi v8's ShapePath.addPath performs
  // non-zero-rule hole detection: any closed subpath whose anchors are
  // fully contained inside an earlier subpath becomes a triangulated
  // hole in that outer subpath (earcut with holes). Without this the
  // outer fill and each inner fill draw independently in the same
  // colour, producing a solid silhouette with no visible holes — the
  // exact AFRY-badge bug. For multi-subpath shapes whose subpaths are
  // NOT nested (dot grids on slide 8), containsPolygon's bounds check
  // fast-rejects in O(1) per pair so the path renders as before.
  const wantClose = data.closed === true
  const path = new GraphicsPath(undefined, /* signed = */ true)
  let subStart = anchors[0]!
  path.moveTo(subStart.x, subStart.y)
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!
    const cur = anchors[i]!
    if (cur.moveTo === true) {
      // Close the previous subpath if the path is overall closed.
      if (wantClose) {
        if (prev.cpOut !== undefined && subStart.cpIn !== undefined) {
          path.bezierCurveTo(
            prev.x + prev.cpOut.x,
            prev.y + prev.cpOut.y,
            subStart.x + subStart.cpIn.x,
            subStart.y + subStart.cpIn.y,
            subStart.x,
            subStart.y,
          )
        } else {
          path.lineTo(subStart.x, subStart.y)
        }
        path.closePath()
      }
      // Begin a fresh subpath at `cur`.
      path.moveTo(cur.x, cur.y)
      subStart = cur
      continue
    }
    if (prev.cpOut !== undefined && cur.cpIn !== undefined) {
      path.bezierCurveTo(
        prev.x + prev.cpOut.x,
        prev.y + prev.cpOut.y,
        cur.x + cur.cpIn.x,
        cur.y + cur.cpIn.y,
        cur.x,
        cur.y,
      )
    } else {
      path.lineTo(cur.x, cur.y)
    }
  }
  if (wantClose) {
    const last = anchors[anchors.length - 1]!
    if (last.cpOut !== undefined && subStart.cpIn !== undefined) {
      path.bezierCurveTo(
        last.x + last.cpOut.x,
        last.y + last.cpOut.y,
        subStart.x + subStart.cpIn.x,
        subStart.y + subStart.cpIn.y,
        subStart.x,
        subStart.y,
      )
    } else {
      path.lineTo(subStart.x, subStart.y)
    }
    path.closePath()
  }
  return path
}

function drawPath(g: Graphics, container: PixiContainer, data: PathObject): void {
  g.clear()
  const anchors = data.anchors
  if (anchors.length === 0) return

  const closed = data.closed === true
  const hasFill = closed && (data.fill !== undefined || data.fillStyle !== undefined)

  // Build the path once; feed it into the Graphics context via
  // `g.path(...)` which routes through ShapePath.addPath and triggers
  // hole detection on multi-subpath inputs (see buildPath comment).
  const path = buildPath(data)
  if (path === null) return

  // Fill pass: g.path(path) + g.fill(...). Mirrors polygonRenderer's
  // image / gradient handling so closed paths share the parametric
  // shapes' appearance pipeline (solid / linear / radial / image).
  if (hasFill) {
    g.path(path)
    if (data.fillStyle?.kind === 'image') {
      const texture = ensureImageFill(container, data.fillStyle, () => {
        const cachedData = asAny(container)[LATEST_DATA_TAG] as PathObject | undefined
        const cachedG = getGraphics(container)
        if (cachedData !== undefined && cachedG !== undefined)
          drawPath(cachedG, container, cachedData)
      })
      const fillColour = resolveColour(data.fill ?? 0xffffff)
      if (texture !== null) {
        g.fill(imageFillToPixiFill(data.fillStyle, texture, data.width, data.height))
      } else {
        g.fill({ color: fillColour, alpha: data.fillAlpha ?? 1 })
      }
    } else {
      releaseImageFill(container)
      const fillColour = resolveColour(data.fill ?? 0xffffff)
      const resolved = fillStyleToPixi(
        data.fillStyle,
        fillColour,
        data.width,
        data.height,
        container,
      )
      const fillInput =
        data.fillStyle === undefined
          ? { color: fillColour, alpha: data.fillAlpha ?? 1 }
          : resolved.input
      g.fill(fillInput)
    }
  } else {
    // Path is open or has no fill — drop any cached fill resources so a
    // path that was once filled doesn't leak procedural / image textures.
    releaseImageFill(container)
    releaseProceduralFill(container)
  }

  asAny(container)[LATEST_DATA_TAG] = data

  // Stroke pass: re-feed the path and stroke. (Pixi Graphics drops the
  // active path after fill() is committed; re-feeding is the canonical
  // pattern.) `g.path(path)` clones the GraphicsPath internally so the
  // same instance is safe to reuse.
  if (data.strokeWidth > 0) {
    g.path(path)
    g.stroke({
      color: resolveColour(data.stroke),
      alpha: data.strokeAlpha ?? 1,
      width: data.strokeWidth,
      cap: 'round',
      join: 'round',
    })
  }
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
    asAny(container)[GRAPHICS_TAG] = g
    drawPath(g, container, data)
    container.addChild(g)
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
      prev.fillStyle !== next.fillStyle ||
      prev.closed !== next.closed ||
      prev.width !== next.width ||
      prev.height !== next.height ||
      !anchorsEqual(prev.anchors, next.anchors)
    if (redraw) {
      const g = getGraphics(node)
      if (g !== undefined) drawPath(g, node, next)
    }
    applyFilterEffects(node, next.shadow, next.blur)
  },
  /** Fill and stroke resolve token colours: redraw them (index.ts, repaintColours). */
  repaintColours(node: PixiContainer, data: PathObject): void {
    const g = getGraphics(node)
    if (g !== undefined) drawPath(g, node, data)
  },
  destroy(node: PixiContainer): void {
    const g = getGraphics(node)
    releaseImageFill(node)
    releaseProceduralFill(node)
    g?.destroy()
    destroyFilterEffects(node)
    node.destroy()
  },
}
