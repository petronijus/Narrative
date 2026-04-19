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

/** Interní tag klíče pro identifikaci Graphics a cached state uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('rectGraphics')
/**
 * Cached fill hodnota — potřebná pro applyPatch při geometry změně bez fill v patch.
 * Pixi Graphics nemá veřejný getter na nakreslenou barvu, takže si ji cachujeme.
 */
const FILL_TAG = Symbol('rectFill')

function applyObjectTransform(container: Container, data: RectangleObject): void {
  container.x = data.x
  container.y = data.y
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot na střed objektu pro správnou rotaci
  container.pivot.set(data.width / 2, data.height / 2)
}

function drawRect(graphics: Graphics, data: RectangleObject): void {
  graphics.clear()
  graphics.rect(0, 0, data.width, data.height)
  graphics.fill({ color: data.fill })
}

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

export const rectangleRenderer = {
  type: 'rectangle' as const,

  /**
   * Vytvoří nový Container s Graphics pro dané RectangleObject data.
   * Container je pozicován a otočen podle dat. Pivot je na středu.
   */
  mount(data: RectangleObject): Container {
    const container = new Container()
    const graphics = new Graphics()

    drawRect(graphics, data)
    container.addChild(graphics)

    asAny(container)[GRAPHICS_TAG] = graphics
    setCachedFill(container, data.fill)

    applyObjectTransform(container, data)

    // Pivot offset: object je definován levým horním rohem, ale pivot je na středu
    container.x = data.x + data.width / 2
    container.y = data.y + data.height / 2

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
      prev.fill !== next.fill || prev.width !== next.width || prev.height !== next.height

    if (needsRedraw) {
      const graphics = getGraphics(node)
      if (graphics !== undefined) {
        drawRect(graphics, next)
        setCachedFill(node, next.fill)
      }
    }
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
    const fillChanged = patch.fill !== undefined

    if (geometryChanged || fillChanged) {
      const graphics = getGraphics(node)
      if (graphics === undefined) return

      // Rekonstrukce aktuálních hodnot z cached state v containeru
      const currentPivotX = node.pivot.x
      const currentPivotY = node.pivot.y
      const currentWorldX = node.x
      const currentWorldY = node.y
      // data.x = worldX - pivotX (pivot = width/2)
      const dataX = currentWorldX - currentPivotX
      const dataY = currentWorldY - currentPivotY
      const currentWidth = currentPivotX * 2
      const currentHeight = currentPivotY * 2

      const newWidth = patch.width ?? currentWidth
      const newHeight = patch.height ?? currentHeight
      const newFill = patch.fill ?? getCachedFill(node)

      const pseudoObj: RectangleObject = {
        id: '',
        type: 'rectangle',
        x: dataX,
        y: dataY,
        width: newWidth,
        height: newHeight,
        fill: newFill,
        rotation: node.rotation,
        opacity: node.alpha,
      }
      drawRect(graphics, pseudoObj)
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
