/**
 * renderer/objectRenderers/textRenderer.ts
 *
 * Object renderer pro typ 'text'.
 *
 * Konsistentní signatura s rectangleRenderer a ellipseRenderer:
 * - mount(): vytvoří Container + Pixi Text node s TextStyle.
 * - update(): aktualizuje text/style properties s minimálním rebuild.
 * - destroy(): uvolní Text node a Container.
 *
 * POZNÁMKA — data.height:
 * Aktuálně ignorujeme data.height pro layout — Pixi Text auto-měří výšku
 * podle obsahu. data.height bude relevantní v M5+ pro clipping/scrollable text.
 * TODO(M5): implementovat clipping mask podle data.height.
 *
 * POZNÁMKA — DOM overlay pro edit mode:
 * Tento renderer zobrazuje text v Pixi. DOM overlay (contenteditable/textarea)
 * pro text edit mode řeší OverlayCompositor + editor-ui agent (fáze 2b).
 * TextRenderer nemanipuluje s DOM.
 *
 * Pivot je na středu objektu (width/2, height/2) — stejný vzor jako ostatní renderers.
 */

import { Container, Text, TextStyle } from 'pixi.js'
import type { TextObject } from '../types'

/** Interní tag klíče pro identifikaci Text node uvnitř Containeru. */
const TEXT_TAG = Symbol('textNode')

/** Převede hex number na CSS color string pro TextStyle. */
function hexToColorString(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

function buildStyle(data: TextObject): TextStyle {
  return new TextStyle({
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: data.fontSize,
    fontWeight: data.fontWeight,
    fill: hexToColorString(data.color),
    align: data.align,
    wordWrap: true,
    wordWrapWidth: data.width,
  })
}

function applyObjectTransform(container: Container, data: TextObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot na střed objektu pro správnou rotaci
  container.pivot.set(data.width / 2, data.height / 2)
  // Pivot offset: object je definován levým horním rohem, ale pivot je na středu
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

export const textRenderer = {
  type: 'text' as const,

  /**
   * Vytvoří nový Container s Pixi Text node pro dané TextObject data.
   * Container je pozicován a otočen podle dat. Pivot je na středu.
   */
  mount(data: TextObject): Container {
    const container = new Container()
    const style = buildStyle(data)
    const textNode = new Text({ text: data.text, style })

    container.addChild(textNode)

    // Ukládáme referenci na Text node pro pozdější update/destroy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    ;(container as any)[TEXT_TAG] = textNode

    applyObjectTransform(container, data)

    return container
  },

  /**
   * Aktualizuje existující Container podle nových dat.
   * Reuse Text node — rebuild style jen pokud se změnily vizuální properties.
   * Šetří zbytečné GC pressure z nových objektů na každý update.
   */
  update(node: Container, prev: TextObject, next: TextObject): void {
    applyObjectTransform(node, next)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    const textNode = (node as any)[TEXT_TAG] as Text | undefined
    if (textNode === undefined) return

    // Aktualizuj text content pokud se změnil
    if (prev.text !== next.text) {
      textNode.text = next.text
    }

    // Aktualizuj style pokud se změnily vizuální properties
    const styleChanged =
      prev.fontSize !== next.fontSize ||
      prev.fontWeight !== next.fontWeight ||
      prev.color !== next.color ||
      prev.align !== next.align ||
      prev.width !== next.width

    if (styleChanged) {
      textNode.style = buildStyle(next)
    }
  },

  /**
   * Uvolní Text node a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
    const textNode = (node as any)[TEXT_TAG] as Text | undefined
    textNode?.destroy()
    node.destroy()
  },
}
