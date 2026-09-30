/**
 * renderer/objectRenderers/rectangleRenderer.ts
 *
 * Object renderer pro typ 'rectangle'.
 *
 * Odpovědnosti:
 * - mount(): vytvoří Pixi Container + Graphics, nastaví fill/pozici/transformace.
 * - update(): aplikuje diff — repositioning a refill pokud se změnily properties.
 * - applyPatch(): M3 chirurgický patch — aktualizuje jen dotčené fields.
 * - destroy(): uvolní Graphics i Container.
 */

import { Container, Graphics } from 'pixi.js'
import type { RectangleObject } from '../types'
import type { CornerRadius } from '@narrative/shared'
import { fillStyleToPixi, imageFillToPixiFill, releaseProceduralFill } from '../fillStyleToPixi.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { strokeDashedPolyline, sampleRoundedRect } from '../strokeDashed.js'
import { ensureImageFill, releaseImageFill } from '../imageFillLoader.js'
import { applyFlip } from './applyFlip.js'
import { resolveColour } from '../colourResolver.js'

function cornerRadiusEqual(a: CornerRadius | undefined, b: CornerRadius | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'number' || typeof b === 'number') return false
  return a.tl === b.tl && a.tr === b.tr && a.br === b.br && a.bl === b.bl
}

/** Interní tag klíče pro identifikaci Graphics a cached state uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('rectGraphics')
/**
 * P5b: cache the full RectangleObject data on the container. applyPatch
 * only receives a diff so it needs the last snapshot to drive the redraw
 * whenever any visual field (fill, stroke, cornerRadius, width, height)
 * changes. Storing the whole object instead of individual symbols keeps
 * that bookkeeping tidy.
 */
const DATA_TAG = Symbol('rectData')

function applyObjectTransform(container: Container, data: RectangleObject): void {
  container.x = data.x
  container.y = data.y
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot na střed objektu pro správnou rotaci
  container.pivot.set(data.width / 2, data.height / 2)
  applyFlip(container, data)
}

/**
 * P5b: rounded-rect path. Pixi v8's Graphics.roundRect takes a single
 * radius, so for per-corner radii we trace the outline manually via
 * arcTo segments. `r` is clamped per-corner so a big radius on a tiny
 * rect doesn't overshoot the opposite side.
 */
function tracePath(g: Graphics, w: number, h: number, r: RectangleObject['cornerRadius']): void {
  const tl = typeof r === 'number' ? r : (r?.tl ?? 0)
  const tr = typeof r === 'number' ? r : (r?.tr ?? 0)
  const br = typeof r === 'number' ? r : (r?.br ?? 0)
  const bl = typeof r === 'number' ? r : (r?.bl ?? 0)
  const maxR = Math.min(w, h) / 2
  const cTl = Math.max(0, Math.min(tl, maxR))
  const cTr = Math.max(0, Math.min(tr, maxR))
  const cBr = Math.max(0, Math.min(br, maxR))
  const cBl = Math.max(0, Math.min(bl, maxR))
  if (cTl === 0 && cTr === 0 && cBr === 0 && cBl === 0) {
    g.rect(0, 0, w, h)
    return
  }
  // Uniform radius — use Pixi's `roundRect` primitive. The manual
  // arcTo/lineTo trace produces visible white seams under thick
  // centred strokes (Pixi v8 strokes each path segment separately
  // and the joins don't fully fill the corners). `roundRect` emits
  // one closed shape which the stroker handles as a single primitive.
  if (cTl === cTr && cTr === cBr && cBr === cBl) {
    g.roundRect(0, 0, w, h, cTl)
    return
  }
  // Per-corner radii — fall back to the manual trace. Strokes here
  // can show the same seam artefact, but per-corner radii aren't a
  // common combination with thick strokes.
  g.moveTo(cTl, 0)
  g.lineTo(w - cTr, 0)
  if (cTr > 0) g.arcTo(w, 0, w, cTr, cTr)
  g.lineTo(w, h - cBr)
  if (cBr > 0) g.arcTo(w, h, w - cBr, h, cBr)
  g.lineTo(cBl, h)
  if (cBl > 0) g.arcTo(0, h, 0, h - cBl, cBl)
  g.lineTo(0, cTl)
  if (cTl > 0) g.arcTo(0, 0, cTl, 0, cTl)
  g.closePath()
}

function drawRect(graphics: Graphics, container: Container, data: RectangleObject): void {
  graphics.clear()
  tracePath(graphics, data.width, data.height, data.cornerRadius)
  const fillColour = resolveColour(data.fill)
  if (data.fillStyle?.kind === 'image') {
    // Image fill: ask the loader for a cached texture. When we hit a
    // cache miss, null is returned — we paint the solid fallback while
    // the async chain resolves, and the onReady callback re-enters this
    // draw routine with the texture in place.
    const texture = ensureImageFill(container, data.fillStyle, () => {
      const cached = getCachedData(container)
      const g = getGraphics(container)
      if (cached !== undefined && g !== undefined) drawRect(g, container, cached)
    })
    if (texture !== null) {
      graphics.fill(imageFillToPixiFill(data.fillStyle, texture, data.width, data.height))
    } else {
      graphics.fill({ color: fillColour, alpha: data.fillAlpha ?? 1 })
    }
  } else {
    releaseImageFill(container)
    const resolved = fillStyleToPixi(data.fillStyle, fillColour, data.width, data.height, container)
    const fillInput =
      data.fillStyle === undefined
        ? { color: fillColour, alpha: data.fillAlpha ?? 1 }
        : resolved.input
    graphics.fill(fillInput)
  }
  if (data.stroke !== undefined && (data.strokeWidth ?? 0) > 0) {
    const strokeColour = resolveColour(data.stroke)
    const w = data.strokeWidth ?? 1
    const strokeAlpha = data.strokeAlpha ?? 1
    if (data.strokeDash === true) {
      const r =
        typeof data.cornerRadius === 'number'
          ? {
              tl: data.cornerRadius,
              tr: data.cornerRadius,
              br: data.cornerRadius,
              bl: data.cornerRadius,
            }
          : (data.cornerRadius ?? { tl: 0, tr: 0, br: 0, bl: 0 })
      const pts = sampleRoundedRect(data.width, data.height, r)
      strokeDashedPolyline(graphics, pts, true, {
        color: strokeColour,
        width: w,
        alpha: strokeAlpha,
      })
    } else {
      tracePath(graphics, data.width, data.height, data.cornerRadius)
      graphics.stroke({ color: strokeColour, width: w, alignment: 0.5, alpha: strokeAlpha })
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
const asAny = (node: Container): any => node as any

function getGraphics(node: Container): Graphics | undefined {
  return asAny(node)[GRAPHICS_TAG] as Graphics | undefined
}

function getCachedData(node: Container): RectangleObject | undefined {
  return asAny(node)[DATA_TAG] as RectangleObject | undefined
}

function setCachedData(node: Container, data: RectangleObject): void {
  asAny(node)[DATA_TAG] = data
}

export const rectangleRenderer = {
  type: 'rectangle' as const,

  /**
   * Vytvoří nový Container s Graphics pro dané RectangleObject data.
   * Container je pozicován a otočen podle dat. Pivot je na středu.
   */
  mount(data: RectangleObject): Container {
    const container = new Container()
    const graphics = new Graphics()

    asAny(container)[GRAPHICS_TAG] = graphics
    setCachedData(container, data)

    drawRect(graphics, container, data)
    container.addChild(graphics)

    applyObjectTransform(container, data)

    // Pivot offset: object je definován levým horním rohem, ale pivot je na středu
    container.x = data.x + data.width / 2
    container.y = data.y + data.height / 2

    applyFilterEffects(container, data.shadow, data.blur)

    return container
  },

  /**
   * Aktualizuje existující Container podle nových dat.
   * Překreslí Graphics pouze pokud se změnily fill nebo rozměry.
   */
  update(node: Container, prev: RectangleObject, next: RectangleObject): void {
    applyObjectTransform(node, next)
    node.x = next.x + next.width / 2
    node.y = next.y + next.height / 2

    const needsRedraw =
      prev.fill !== next.fill ||
      prev.fillAlpha !== next.fillAlpha ||
      prev.width !== next.width ||
      prev.height !== next.height ||
      prev.stroke !== next.stroke ||
      prev.strokeAlpha !== next.strokeAlpha ||
      prev.strokeWidth !== next.strokeWidth ||
      prev.strokeDash !== next.strokeDash ||
      !cornerRadiusEqual(prev.cornerRadius, next.cornerRadius) ||
      prev.fillStyle !== next.fillStyle

    if (needsRedraw) {
      const graphics = getGraphics(node)
      if (graphics !== undefined) {
        setCachedData(node, next)
        drawRect(graphics, node, next)
      }
    } else {
      setCachedData(node, next)
    }

    applyFilterEffects(node, next.shadow, next.blur)
  },

  /**
   * Chirurgický patch update — aktualizuje jen fields přítomné v patch.
   *
   * Strategie:
   * - x | y → repozice (pivot nezměněn pokud width/height nejsou v patchi)
   * - width | height → redraw geometry + pivot přepočet + repozice
   * - fill → redraw fill
   * - rotation → node.rotation
   * - opacity → node.alpha
   *
   * Pixi Container ukládá pozici jako node.x = data.x + pivot.x, proto
   * rekonstruujeme data.x = node.x - pivot.x při geometry změně.
   */
  applyPatch(node: Container, patch: Partial<RectangleObject>): void {
    // Pozice — jednoduché přepočty bez nutnosti znát full object
    if (patch.x !== undefined) {
      node.x = patch.x + node.pivot.x
    }
    if (patch.y !== undefined) {
      node.y = patch.y + node.pivot.y
    }

    if (patch.rotation !== undefined) {
      node.rotation = patch.rotation
    }

    if (patch.opacity !== undefined) {
      node.alpha = patch.opacity
    }

    const geometryChanged = patch.width !== undefined || patch.height !== undefined
    const visualChanged =
      patch.fill !== undefined ||
      'fillAlpha' in patch ||
      'fillStyle' in patch ||
      'stroke' in patch ||
      'strokeAlpha' in patch ||
      patch.strokeWidth !== undefined ||
      'strokeDash' in patch ||
      'cornerRadius' in patch
    const filterChanged = 'shadow' in patch || 'blur' in patch

    const cached = getCachedData(node)

    if (geometryChanged || visualChanged) {
      const graphics = getGraphics(node)
      if (graphics === undefined || cached === undefined) return

      const newWidth = patch.width ?? cached.width
      const newHeight = patch.height ?? cached.height

      const nextStroke = 'stroke' in patch ? patch.stroke : cached.stroke
      const nextStrokeAlpha = 'strokeAlpha' in patch ? patch.strokeAlpha : cached.strokeAlpha
      const nextStrokeWidth = 'strokeWidth' in patch ? patch.strokeWidth : cached.strokeWidth
      const nextStrokeDash = 'strokeDash' in patch ? patch.strokeDash : cached.strokeDash
      const nextCornerRadius = 'cornerRadius' in patch ? patch.cornerRadius : cached.cornerRadius
      const nextFillStyle = 'fillStyle' in patch ? patch.fillStyle : cached.fillStyle
      const nextFillAlpha = 'fillAlpha' in patch ? patch.fillAlpha : cached.fillAlpha

      // exactOptionalPropertyTypes: omit keys whose value is undefined.
      const next: RectangleObject = {
        ...cached,
        width: newWidth,
        height: newHeight,
        fill: patch.fill ?? cached.fill,
        ...(nextFillAlpha !== undefined ? { fillAlpha: nextFillAlpha } : {}),
        ...(nextStroke !== undefined ? { stroke: nextStroke } : {}),
        ...(nextStrokeAlpha !== undefined ? { strokeAlpha: nextStrokeAlpha } : {}),
        ...(nextStrokeWidth !== undefined ? { strokeWidth: nextStrokeWidth } : {}),
        ...(nextStrokeDash !== undefined ? { strokeDash: nextStrokeDash } : {}),
        ...(nextCornerRadius !== undefined ? { cornerRadius: nextCornerRadius } : {}),
        ...(nextFillStyle !== undefined ? { fillStyle: nextFillStyle } : {}),
      }
      if (nextFillAlpha === undefined) delete (next as { fillAlpha?: number }).fillAlpha
      if (nextStroke === undefined) delete (next as { stroke?: number }).stroke
      if (nextStrokeAlpha === undefined) delete (next as { strokeAlpha?: number }).strokeAlpha
      if (nextStrokeWidth === undefined) delete (next as { strokeWidth?: number }).strokeWidth
      if (nextStrokeDash === undefined) delete (next as { strokeDash?: boolean }).strokeDash
      if (nextCornerRadius === undefined)
        delete (next as { cornerRadius?: CornerRadius }).cornerRadius
      if (nextFillStyle === undefined)
        delete (next as { fillStyle?: RectangleObject['fillStyle'] }).fillStyle

      setCachedData(node, next)
      drawRect(graphics, node, next)

      if (geometryChanged) {
        const newPivotX = newWidth / 2
        const newPivotY = newHeight / 2
        const currentWorldX = node.x
        const currentWorldY = node.y
        const currentPivotX = node.pivot.x
        const currentPivotY = node.pivot.y
        const dataX = currentWorldX - currentPivotX
        const dataY = currentWorldY - currentPivotY
        node.pivot.set(newPivotX, newPivotY)
        node.x = dataX + newPivotX
        node.y = dataY + newPivotY
      }
    }

    if (filterChanged && cached !== undefined) {
      const nextShadow = 'shadow' in patch ? patch.shadow : cached.shadow
      const nextBlur = 'blur' in patch ? patch.blur : cached.blur
      applyFilterEffects(node, nextShadow, nextBlur)
      const updated: RectangleObject = { ...cached }
      if ('shadow' in patch) {
        if (nextShadow !== undefined) updated.shadow = nextShadow
        else delete updated.shadow
      }
      if ('blur' in patch) {
        if (nextBlur !== undefined) updated.blur = nextBlur
        else delete updated.blur
      }
      setCachedData(node, updated)
    }
  },

  /** Fill and stroke resolve token colours: redraw them (index.ts, repaintColours). */
  repaintColours(node: Container, data: RectangleObject): void {
    const graphics = getGraphics(node)
    if (graphics === undefined) return
    setCachedData(node, data)
    drawRect(graphics, node, data)
  },

  /**
   * Uvolní Graphics a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    releaseImageFill(node)
    releaseProceduralFill(node)
    const graphics = getGraphics(node)
    graphics?.destroy()
    destroyFilterEffects(node)
    node.destroy()
  },
}
