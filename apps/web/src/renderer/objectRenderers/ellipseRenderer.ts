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

/** Interní tag klíče pro identifikaci Graphics a cached fill uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('ellipseGraphics')
/**
 * Cached fill hodnota — potřebná pro applyPatch při geometry změně bez fill v patch.
 * Pixi Graphics nemá veřejný getter na nakreslenou barvu.
 */
const FILL_TAG = Symbol('ellipseFill')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
const asAny = (node: Container): any => node as any

function getGraphics(node: Container): Graphics | undefined {
  return asAny(node)[GRAPHICS_TAG] as Graphics | undefined
}

function getCachedFill(node: Container): number {
  return (asAny(node)[FILL_TAG] as number | undefined) ?? 0
}

function setCachedFill(node: Container, fill: number): void {
  asAny(node)[FILL_TAG] = fill
}

function applyObjectTransform(container: Container, data: EllipseObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot na střed objektu pro správnou rotaci
  container.pivot.set(data.width / 2, data.height / 2)
  // Pivot offset: object je definován levým horním rohem, ale pivot je na středu
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

function drawEllipse(graphics: Graphics, data: EllipseObject): void {
  graphics.clear()
  // Pixi v8 path API: ellipse(centerX, centerY, halfWidth, halfHeight)
  // Geometrie je vykreslena od (0,0) — container provede transform
  graphics.ellipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2)
  graphics.fill({ color: data.fill })
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

    drawEllipse(graphics, data)
    container.addChild(graphics)

    asAny(container)[GRAPHICS_TAG] = graphics
    setCachedFill(container, data.fill)

    applyObjectTransform(container, data)

    return container
  },

  /**
   * Aktualizuje existující Container podle nových dat.
   * Překreslí Graphics pouze pokud se změnily fill nebo rozměry.
   */
  update(node: Container, prev: EllipseObject, next: EllipseObject): void {
    applyObjectTransform(node, next)

    const needsRedraw =
      prev.fill !== next.fill || prev.width !== next.width || prev.height !== next.height

    if (needsRedraw) {
      const graphics = getGraphics(node)
      if (graphics !== undefined) {
        drawEllipse(graphics, next)
        setCachedFill(node, next.fill)
      }
    }
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
    const fillChanged = patch.fill !== undefined

    if (geometryChanged || fillChanged) {
      const graphics = getGraphics(node)
      if (graphics === undefined) return

      const currentPivotX = node.pivot.x
      const currentPivotY = node.pivot.y
      const currentWorldX = node.x
      const currentWorldY = node.y
      const dataX = currentWorldX - currentPivotX
      const dataY = currentWorldY - currentPivotY
      const currentWidth = currentPivotX * 2
      const currentHeight = currentPivotY * 2

      const newWidth = patch.width ?? currentWidth
      const newHeight = patch.height ?? currentHeight
      const newFill = patch.fill ?? getCachedFill(node)

      const pseudoObj: EllipseObject = {
        id: '',
        type: 'ellipse',
        x: dataX,
        y: dataY,
        width: newWidth,
        height: newHeight,
        fill: newFill,
        rotation: node.rotation,
        opacity: node.alpha,
      }
      drawEllipse(graphics, pseudoObj)
      setCachedFill(node, newFill)

      if (geometryChanged) {
        const newPivotX = newWidth / 2
        const newPivotY = newHeight / 2
        node.pivot.set(newPivotX, newPivotY)
        node.x = dataX + newPivotX
        node.y = dataY + newPivotY
      }
    }
  },

  /**
   * Uvolní Graphics a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    const graphics = getGraphics(node)
    graphics?.destroy()
    node.destroy()
  },
}
