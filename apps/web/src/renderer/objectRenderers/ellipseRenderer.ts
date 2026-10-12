/**
 * renderer/objectRenderers/ellipseRenderer.ts
 *
 * Object renderer pro typ 'ellipse'.
 *
 * Konsistentní signatura s rectangleRenderer:
 * - mount(): vytvoří Container + Graphics, nastaví elipsu (Pixi v8 path API).
 * - update(): aplikuje diff — repositioning a redraw pokud se změnily properties.
 * - applyPatch(): M3 chirurgický patch — aktualizuje jen dotčené fields.
 * - destroy(): uvolní Graphics i Container.
 *
 * Pivot je na středu objektu (width/2, height/2) — stejný vzor jako rectangle.
 * Geometrie je vždy překreslena redrawem Graphics, nikoliv scale mutací
 * (viz pravidlo: container.scale je ObservablePoint, scale pro geometry change je chybný vzor).
 */

import { Container, Graphics } from 'pixi.js'
import type { EllipseObject } from '../types'
import { fillStyleToPixi, imageFillToPixiFill, releaseProceduralFill } from '../fillStyleToPixi.js'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { strokeDashedPolyline, sampleEllipse } from '../strokeDashed.js'
import { ensureImageFill, releaseImageFill } from '../imageFillLoader.js'
import { applyFlip } from './applyFlip.js'
import { resolveAlpha, resolveColour } from '../colourResolver.js'

/** Interní tag klíče pro identifikaci Graphics a cached fill uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('ellipseGraphics')
/**
 * Cached fill hodnota — potřebná pro applyPatch při geometry změně bez fill v patch.
 * Pixi Graphics nemá veřejný getter na nakreslenou barvu.
 */
const DATA_TAG = Symbol('ellipseData')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
const asAny = (node: Container): any => node as any

function getGraphics(node: Container): Graphics | undefined {
  return asAny(node)[GRAPHICS_TAG] as Graphics | undefined
}

function getCachedData(node: Container): EllipseObject | undefined {
  return asAny(node)[DATA_TAG] as EllipseObject | undefined
}

function setCachedData(node: Container, data: EllipseObject): void {
  asAny(node)[DATA_TAG] = data
}

function applyObjectTransform(container: Container, data: EllipseObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot na střed objektu pro správnou rotaci
  container.pivot.set(data.width / 2, data.height / 2)
  // Pivot offset: object je definován levým horním rohem, ale pivot je na středu
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
  applyFlip(container, data)
}

function drawEllipse(graphics: Graphics, container: Container, data: EllipseObject): void {
  graphics.clear()
  // Pixi v8 path API: ellipse(centerX, centerY, halfWidth, halfHeight)
  // Geometrie je vykreslena od (0,0) — container provede transform
  graphics.ellipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2)
  if (data.fillStyle?.kind === 'image') {
    const texture = ensureImageFill(container, data.fillStyle, () => {
      const cached = getCachedData(container)
      const g = getGraphics(container)
      if (cached !== undefined && g !== undefined) drawEllipse(g, container, cached)
    })
    const fillColour = resolveColour(data.fill)
    if (texture !== null) {
      graphics.fill(imageFillToPixiFill(data.fillStyle, texture, data.width, data.height))
    } else {
      graphics.fill({ color: fillColour, alpha: (data.fillAlpha ?? 1) * resolveAlpha(data.fill) })
    }
  } else {
    releaseImageFill(container)
    const fillColour = resolveColour(data.fill)
    const resolved = fillStyleToPixi(data.fillStyle, fillColour, data.width, data.height, container)
    const fillInput =
      data.fillStyle === undefined
        ? { color: fillColour, alpha: (data.fillAlpha ?? 1) * resolveAlpha(data.fill) }
        : resolved.input
    graphics.fill(fillInput)
  }
  if (data.stroke !== undefined && (data.strokeWidth ?? 0) > 0) {
    const strokeColour = resolveColour(data.stroke)
    const w = data.strokeWidth ?? 1
    const sa = (data.strokeAlpha ?? 1) * resolveAlpha(data.stroke)
    if (data.strokeDash === true) {
      const pts = sampleEllipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2)
      strokeDashedPolyline(graphics, pts, true, { color: strokeColour, width: w, alpha: sa })
    } else {
      graphics.ellipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2)
      graphics.stroke({ color: strokeColour, width: w, alignment: 0.5, alpha: sa })
    }
  }
}

export const ellipseRenderer = {
  type: 'ellipse' as const,

  /**
   * Vytvoří nový Container s Graphics pro dané EllipseObject data.
   * Container je pozicován a otočen podle dat. Pivot je na středu.
   */
  mount(data: EllipseObject): Container {
    const container = new Container()
    const graphics = new Graphics()

    asAny(container)[GRAPHICS_TAG] = graphics
    setCachedData(container, data)

    drawEllipse(graphics, container, data)
    container.addChild(graphics)

    applyObjectTransform(container, data)
    applyFilterEffects(container, data.shadow, data.blur)

    return container
  },

  /**
   * Aktualizuje existující Container podle nových dat.
   * Překreslí Graphics pouze pokud se změnily fill nebo rozměry.
   */
  update(node: Container, prev: EllipseObject, next: EllipseObject): void {
    applyObjectTransform(node, next)

    const needsRedraw =
      prev.fill !== next.fill ||
      prev.fillAlpha !== next.fillAlpha ||
      prev.width !== next.width ||
      prev.height !== next.height ||
      prev.stroke !== next.stroke ||
      prev.strokeAlpha !== next.strokeAlpha ||
      prev.strokeWidth !== next.strokeWidth ||
      prev.strokeDash !== next.strokeDash ||
      prev.fillStyle !== next.fillStyle

    if (needsRedraw) {
      const graphics = getGraphics(node)
      if (graphics !== undefined) {
        setCachedData(node, next)
        drawEllipse(graphics, node, next)
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
   * - x | y → repozice (pivot.x/y zachováno pokud width/height nejsou v patchi)
   * - width | height → redraw geometry + pivot přepočet + repozice
   * - fill → redraw fill
   * - rotation → node.rotation
   * - opacity → node.alpha
   */
  applyPatch(node: Container, patch: Partial<EllipseObject>): void {
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
      'strokeDash' in patch
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
      const nextFillStyle = 'fillStyle' in patch ? patch.fillStyle : cached.fillStyle
      const nextFillAlpha = 'fillAlpha' in patch ? patch.fillAlpha : cached.fillAlpha

      const next: EllipseObject = {
        ...cached,
        width: newWidth,
        height: newHeight,
        fill: patch.fill ?? cached.fill,
        ...(nextFillAlpha !== undefined ? { fillAlpha: nextFillAlpha } : {}),
        ...(nextStroke !== undefined ? { stroke: nextStroke } : {}),
        ...(nextStrokeAlpha !== undefined ? { strokeAlpha: nextStrokeAlpha } : {}),
        ...(nextStrokeWidth !== undefined ? { strokeWidth: nextStrokeWidth } : {}),
        ...(nextStrokeDash !== undefined ? { strokeDash: nextStrokeDash } : {}),
        ...(nextFillStyle !== undefined ? { fillStyle: nextFillStyle } : {}),
      }
      if (nextFillAlpha === undefined) delete (next as { fillAlpha?: number }).fillAlpha
      if (nextStroke === undefined) delete (next as { stroke?: number }).stroke
      if (nextStrokeAlpha === undefined) delete (next as { strokeAlpha?: number }).strokeAlpha
      if (nextStrokeWidth === undefined) delete (next as { strokeWidth?: number }).strokeWidth
      if (nextStrokeDash === undefined) delete (next as { strokeDash?: boolean }).strokeDash
      if (nextFillStyle === undefined)
        delete (next as { fillStyle?: EllipseObject['fillStyle'] }).fillStyle

      setCachedData(node, next)
      drawEllipse(graphics, node, next)

      if (geometryChanged) {
        const newPivotX = newWidth / 2
        const newPivotY = newHeight / 2
        const currentPivotX = node.pivot.x
        const currentPivotY = node.pivot.y
        const dataX = node.x - currentPivotX
        const dataY = node.y - currentPivotY
        node.pivot.set(newPivotX, newPivotY)
        node.x = dataX + newPivotX
        node.y = dataY + newPivotY
      }
    }

    if (filterChanged && cached !== undefined) {
      const nextShadow = 'shadow' in patch ? patch.shadow : cached.shadow
      const nextBlur = 'blur' in patch ? patch.blur : cached.blur
      applyFilterEffects(node, nextShadow, nextBlur)
      const updated: EllipseObject = { ...cached }
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
  repaintColours(node: Container, data: EllipseObject): void {
    const graphics = getGraphics(node)
    if (graphics === undefined) return
    setCachedData(node, data)
    drawEllipse(graphics, node, data)
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
