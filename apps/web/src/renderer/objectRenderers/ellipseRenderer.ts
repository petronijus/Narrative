/**
 * renderer/objectRenderers/ellipseRenderer.ts
 *
 * Object renderer pro typ 'ellipse'.
 *
 * Konsistentní signatura s rectangleRenderer:
 * - mount(): vytvoří Container + Graphics, nastaví elipsu (Pixi v8 path API).
 * - update(): aplikuje diff — repositioning a redraw pokud se změnily properties.
 * - destroy(): uvolní Graphics i Container.
 *
 * Pivot je na středu objektu (width/2, height/2) — stejný vzor jako rectangle.
 * Geometrie je vždy překreslena redrawem Graphics, nikoliv scale mutací
 * (viz pravidlo: container.scale je ObservablePoint, scale pro geometry change je chybný vzor).
 */

import { Container, Graphics } from 'pixi.js'
import type { EllipseObject } from '../types'

/** Interní tag klíč pro identifikaci Graphics uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('ellipseGraphics')

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

    // Ukládáme referenci na Graphics pro pozdější update/destroy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    ;(container as any)[GRAPHICS_TAG] = graphics

    applyObjectTransform(container, data)

    return container
  },

  /**
   * Aktualizuje existující Container podle nových dat.
   * Překreslí Graphics pouze pokud se změnily fill nebo rozměry.
   */
  update(node: Container, prev: EllipseObject, next: EllipseObject): void {
    applyObjectTransform(node, next)

    // Graphics překreslíme jen pokud se změnily vizuální properties
    const needsRedraw =
      prev.fill !== next.fill || prev.width !== next.width || prev.height !== next.height

    if (needsRedraw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
      const graphics = (node as any)[GRAPHICS_TAG] as Graphics | undefined
      if (graphics !== undefined) {
        drawEllipse(graphics, next)
      }
    }
  },

  /**
   * Uvolní Graphics a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    const graphics = (node as any)[GRAPHICS_TAG] as Graphics | undefined
    graphics?.destroy()
    node.destroy()
  },
}
