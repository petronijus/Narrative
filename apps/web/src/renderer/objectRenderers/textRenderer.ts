/**
 * renderer/objectRenderers/textRenderer.ts
 *
 * Object renderer pro typ 'text'.
 *
 * Konsistentní signatura s rectangleRenderer a ellipseRenderer:
 * - mount(): vytvoří Container + Pixi Text node s TextStyle.
 * - update(): aktualizuje text/style properties s minimálním rebuild.
 * - applyPatch(): M3 chirurgický patch — mění jen dotčené fields.
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
 *
 * applyPatch granularity:
 * - Změna x/y/rotation/opacity → POUZE container transform, ŽÁDNÝ TextStyle rebuild.
 * - Změna text → pouze textNode.text = patch.text, ŽÁDNÝ TextStyle rebuild.
 * - Změna fontSize/fontWeight/color/align/width → TextStyle rebuild (nevyhnutelné).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Symbol property na Pixi Container není typovaný
const asAny = (node: Container): any => node as any

function getTextNode(node: Container): Text | undefined {
  return asAny(node)[TEXT_TAG] as Text | undefined
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

    asAny(container)[TEXT_TAG] = textNode

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

    const textNode = getTextNode(node)
    if (textNode === undefined) return

    if (prev.text !== next.text) {
      textNode.text = next.text
    }

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
   * Chirurgický patch update — mění jen dotčené fields.
   *
   * Klíčová granularita:
   * - patch { x } → pouze node.x, BEZ TextStyle rebuild
   * - patch { text } → pouze textNode.text, BEZ TextStyle rebuild
   * - patch { fontSize | fontWeight | color | align | width } → TextStyle rebuild
   *
   * width v patch ovlivňuje wordWrapWidth (TextStyle) A pivot/pozici containeru.
   * Oba efekty jsou aplikovány pokud je width v patchi.
   */
  applyPatch(node: Container, patch: Partial<TextObject>): void {
    // Pozice — aktualizuj bez TextStyle rebuild
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

    // height změna → přepočítej pivot.y a pozici
    if (patch.height !== undefined) {
      const currentPivotX = node.pivot.x
      const _dataX = node.x - currentPivotX
      const dataY = node.y - node.pivot.y
      const newPivotY = patch.height / 2
      node.pivot.set(currentPivotX, newPivotY)
      node.y = dataY + newPivotY
    }

    const textNode = getTextNode(node)
    if (textNode === undefined) return

    // Text content — bez TextStyle rebuild
    if (patch.text !== undefined) {
      textNode.text = patch.text
    }

    // Style-affecting fields — rebuild TextStyle jen pokud se něco změnilo
    const needsStyleRebuild =
      patch.fontSize !== undefined ||
      patch.fontWeight !== undefined ||
      patch.color !== undefined ||
      patch.align !== undefined ||
      patch.width !== undefined

    if (needsStyleRebuild) {
      // Přečteme aktuální style z Text node a aplikujeme jen změny.
      // Pixi TextStyle je mutable — updatujeme přímo místo rebuild.
      const currentStyle = textNode.style as TextStyle

      if (patch.fontSize !== undefined) currentStyle.fontSize = patch.fontSize
      if (patch.fontWeight !== undefined) currentStyle.fontWeight = patch.fontWeight
      if (patch.color !== undefined) currentStyle.fill = hexToColorString(patch.color)
      if (patch.align !== undefined) currentStyle.align = patch.align
      if (patch.width !== undefined) {
        currentStyle.wordWrapWidth = patch.width
        // width mění i pivot.x a pozici containeru
        const dataX = node.x - node.pivot.x
        const newPivotX = patch.width / 2
        node.pivot.set(newPivotX, node.pivot.y)
        node.x = dataX + newPivotX
      }
    }
  },

  /**
   * Uvolní Text node a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    const textNode = getTextNode(node)
    textNode?.destroy()
    node.destroy()
  },
}
