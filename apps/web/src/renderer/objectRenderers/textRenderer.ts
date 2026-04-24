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
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'

/** Interní tag klíče pro identifikaci Text node uvnitř Containeru. */
const TEXT_TAG = Symbol('textNode')

/** Převede hex number na CSS color string pro TextStyle. */
function hexToColorString(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

/**
 * P7: prefix each line with a list marker. Bullet uses `•`, numbered
 * uses `1. 2. 3.` Applied to the rendered string only (Y.Doc stores
 * plain text) so editing doesn't have to strip markers.
 */
function applyListMarkers(raw: string, style: TextObject['listStyle']): string {
  if (style === undefined) return raw
  const lines = raw.split('\n')
  if (style === 'bullet') return lines.map((l) => (l.length > 0 ? `•  ${l}` : l)).join('\n')
  let n = 1
  return lines
    .map((l) => {
      if (l.length === 0) return l
      const out = `${n}.  ${l}`
      n += 1
      return out
    })
    .join('\n')
}

function buildStyle(data: TextObject): TextStyle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi TextStyle options loosely typed
  const opts: any = {
    fontFamily: data.fontFamily ?? 'system-ui, -apple-system, sans-serif',
    fontSize: data.fontSize,
    fontWeight: data.fontWeight,
    fontStyle: data.italic === true ? 'italic' : 'normal',
    fill: hexToColorString(data.color),
    align: data.align,
    wordWrap: true,
    wordWrapWidth: data.width,
    letterSpacing: data.letterSpacing ?? 0,
  }
  if (data.lineHeight !== undefined && data.lineHeight > 0) {
    opts.lineHeight = data.lineHeight * data.fontSize
  }
  if (data.stroke !== undefined && (data.strokeWidth ?? 1) > 0) {
    opts.stroke = { color: hexToColorString(data.stroke), width: data.strokeWidth ?? 1 }
  }
  return new TextStyle(opts)
}

/**
 * P7: shift the Text node's local Y so the rendered glyph block sits
 * at top / middle / bottom of the object's bounding box. Pixi Text
 * measures itself lazily — we read `text.height` after the style has
 * been set to get the current pixel height.
 */
function applyVerticalAlign(textNode: Text, data: TextObject): void {
  const vAlign = data.vAlign ?? 'top'
  if (vAlign === 'top') {
    textNode.y = 0
    return
  }
  const textHeight = textNode.height
  if (vAlign === 'middle') {
    textNode.y = Math.max(0, (data.height - textHeight) / 2)
  } else {
    textNode.y = Math.max(0, data.height - textHeight)
  }
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
    const textNode = new Text({ text: applyListMarkers(data.text, data.listStyle), style })

    container.addChild(textNode)

    asAny(container)[TEXT_TAG] = textNode

    applyObjectTransform(container, data)
    applyVerticalAlign(textNode, data)
    applyFilterEffects(container, data.shadow, data.blur)

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

    if (prev.text !== next.text || prev.listStyle !== next.listStyle) {
      textNode.text = applyListMarkers(next.text, next.listStyle)
    }

    const styleChanged =
      prev.fontSize !== next.fontSize ||
      prev.fontWeight !== next.fontWeight ||
      prev.color !== next.color ||
      prev.align !== next.align ||
      prev.width !== next.width ||
      prev.fontFamily !== next.fontFamily ||
      prev.italic !== next.italic ||
      prev.underline !== next.underline ||
      prev.letterSpacing !== next.letterSpacing ||
      prev.lineHeight !== next.lineHeight ||
      prev.stroke !== next.stroke ||
      prev.strokeWidth !== next.strokeWidth

    if (styleChanged) {
      textNode.style = buildStyle(next)
    }

    // P7: vertical alignment applies to the text node's Y offset inside
    // the container (container pivot + transform is applied to the box,
    // the text node positions itself inside).
    applyVerticalAlign(textNode, next)

    applyFilterEffects(node, next.shadow, next.blur)
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

    // Text content — if listStyle is also in patch, marker prefix must
    // be regenerated. Otherwise write raw text directly (list markers
    // already in node.text stay intact because we ignore them in Y.Doc).
    const textChanged = patch.text !== undefined
    const listChanged = 'listStyle' in patch

    // P7: any typography-affecting field forces a style rebuild. Rather
    // than hand-patch every combination, we read the last known snapshot
    // merged with the patch and call buildStyle() — cost is one
    // TextStyle allocation per change, which is negligible compared to
    // Pixi's glyph layout work that follows.
    const needsStyleRebuild =
      patch.fontSize !== undefined ||
      patch.fontWeight !== undefined ||
      patch.color !== undefined ||
      patch.align !== undefined ||
      patch.width !== undefined ||
      patch.fontFamily !== undefined ||
      patch.italic !== undefined ||
      patch.underline !== undefined ||
      patch.letterSpacing !== undefined ||
      patch.lineHeight !== undefined ||
      'stroke' in patch ||
      patch.strokeWidth !== undefined

    // Reconstruct the merged next-state by reading Pixi + style fields.
    // We intentionally keep the code coarse here — text objects don't
    // get hammered at 60Hz, so a rebuild per patch is fine.
    if (textChanged || listChanged || needsStyleRebuild) {
      // Build a synthetic "merged" TextObject from current Pixi state +
      // patch. SceneGraph's node.data copy is authoritative but unreachable
      // from here, so we approximate with Pixi's current style values.
      const style = textNode.style as TextStyle
      const current: TextObject = {
        id: '',
        type: 'text',
        x: node.x - node.pivot.x,
        y: node.y - node.pivot.y,
        width: node.pivot.x * 2,
        height: node.pivot.y * 2,
        rotation: node.rotation,
        opacity: node.alpha,
        text: textNode.text,
        fontSize: style.fontSize as number,
        fontWeight: style.fontWeight as TextObject['fontWeight'],
        color: parseInt(((style.fill as string) ?? '#000000').slice(1), 16),
        align: style.align as TextObject['align'],
      }
      const merged: TextObject = { ...current, ...patch } as TextObject
      textNode.style = buildStyle(merged)
      if (textChanged || listChanged) {
        textNode.text = applyListMarkers(merged.text, merged.listStyle)
      }
      if (patch.width !== undefined) {
        const dataX = node.x - node.pivot.x
        const newPivotX = patch.width / 2
        node.pivot.set(newPivotX, node.pivot.y)
        node.x = dataX + newPivotX
      }
      applyVerticalAlign(textNode, merged)
    } else if (textChanged) {
      // Fast path — only text changed, no list, no style.
      textNode.text = patch.text!
    }
    if (patch.vAlign !== undefined || patch.height !== undefined) {
      // Re-align vertically when height or vAlign flips.
      const style = textNode.style as TextStyle
      const snap: TextObject = {
        id: '',
        type: 'text',
        x: 0,
        y: 0,
        width: node.pivot.x * 2,
        height: node.pivot.y * 2,
        rotation: 0,
        opacity: 1,
        text: textNode.text,
        fontSize: style.fontSize as number,
        fontWeight: 'normal',
        color: 0,
        align: 'left',
        ...(patch.vAlign !== undefined ? { vAlign: patch.vAlign } : {}),
      }
      applyVerticalAlign(textNode, snap)
    }

    if ('shadow' in patch || 'blur' in patch) {
      applyFilterEffects(
        node,
        'shadow' in patch ? patch.shadow : undefined,
        'blur' in patch ? patch.blur : undefined,
      )
    }
  },

  /**
   * Uvolní Text node a Container. Volá se při removeObject.
   */
  destroy(node: Container): void {
    const textNode = getTextNode(node)
    textNode?.destroy()
    destroyFilterEffects(node)
    node.destroy()
  },
}
