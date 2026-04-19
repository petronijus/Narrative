/**
 * renderer/objectRenderers/rectangleRenderer.ts
 *
 * Object renderer pro typ 'rectangle'.
 *
 * Odpovědnosti:
 * - mount(): vytvoří Pixi Container + Graphics, nastaví fill/pozici/transformace.
 * - update(): aplikuje diff — repositioning a refill pokud se změnily properties.
 * - destroy(): uvolní Graphics i Container.
 *
 * Poznámka: finální registerObjectType API (inspector, schema, hitTest) přijde v M2
 * spolu se state-sync. Teď interface záměrně minimální.
 */

import { Container, Graphics } from 'pixi.js'
import type { RectangleObject } from '../types'

/** Interní tag klíč pro identifikaci Graphics uvnitř Containeru. */
const GRAPHICS_TAG = Symbol('rectGraphics')

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

    // Ukládáme referenci na Graphics pro pozdější update/destroy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    ;(container as any)[GRAPHICS_TAG] = graphics

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
    // Transformace vždy aktualizujeme
    applyObjectTransform(node, next)
    node.x = next.x + next.width / 2
    node.y = next.y + next.height / 2

    // Graphics překreslíme jen pokud se změnily vizuální properties
    const needsRedraw =
      prev.fill !== next.fill || prev.width !== next.width || prev.height !== next.height

    if (needsRedraw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
      const graphics = (node as any)[GRAPHICS_TAG] as Graphics | undefined
      if (graphics !== undefined) {
        drawRect(graphics, next)
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
