/**
 * renderer/objectRenderers/textRenderer.ts
 *
 * Object renderer for type 'text'.
 *
 * Same signature as rectangleRenderer / ellipseRenderer:
 * - mount(): creates Container + Pixi Text node with TextStyle.
 * - update(): refreshes text / style properties with minimal rebuild.
 * - applyPatch(): surgical patch — touches only fields in the patch.
 * - destroy(): releases Text node and Container.
 *
 * Pivot is at the centre of the object (width/2, height/2) so rotation
 * works the same way as the other renderers.
 *
 * The text-edit DOM overlay (TextEditOverlay) sits on top of the live
 * Pixi container and renders glyphs transparently — this renderer
 * stays the single source of truth for what the user sees, even in
 * edit mode. The overlay reads `textNode.y` from the live container
 * so the editing caret aligns with Pixi's actual measured offset.
 *
 * applyPatch granularity:
 * - x/y/rotation/opacity → container transform only, NO style rebuild.
 * - text-only           → textNode.text only, NO style rebuild.
 * - typography fields   → TextStyle rebuild (unavoidable).
 *
 * applyPatch merges against the last applied data (DATA_TAG) so fields
 * Pixi doesn't track natively (vAlign, listStyle, fontFamily) survive
 * patches that only touch a sibling field.
 */

import { CanvasTextMetrics, Container, Graphics, Text, TextStyle } from 'pixi.js'
import * as Y from 'yjs'
import type { TextObject } from '../types'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'

/**
 * Read the body content as a plain string regardless of whether the
 * underlying schema slot is a `Y.Text` (rich-text path) or a legacy
 * plain `string` (decks saved before the rich-text migration). Phase A
 * of the rich-text rollout still renders plain Pixi.Text from the
 * resulting string; Phase B will replace this with HTML rendering.
 */
function readPlainText(t: TextObject['text']): string {
  if (t instanceof Y.Text) return t.toString()
  if (typeof t === 'string') return t
  return ''
}

/** Tag for the Pixi Text node stored on its parent Container. */
const TEXT_TAG = Symbol('textNode')
/** Tag for the clip-mask Graphics that crops glyphs to the box. */
const MASK_TAG = Symbol('textMask')
/** Tag for the underline Graphics painted under the rendered text.
 *  Pixi v8's TextStyle has no native underline, so we draw a thin
 *  horizontal rectangle below each rendered line's baseline ourselves
 *  (see applyUnderline for the typographic ratios used). */
const UNDERLINE_TAG = Symbol('textUnderline')
/** Last applied data snapshot — applyPatch merges against this so
 *  fields Pixi doesn't track natively (vAlign, listStyle, fontFamily)
 *  survive patches that only touch a sibling field. Without it,
 *  `{ align: 'right' }` would silently reset vAlign back to 'top'. */
const DATA_TAG = Symbol('textData')

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
    // Pixi v8's `fontStringFromTextStyle` auto-quotes unquoted multi-
    // word family names (anything not in the CSS generic set), so we
    // can pass `data.fontFamily` straight through.
    fontFamily: data.fontFamily ?? 'system-ui, -apple-system, sans-serif',
    fontSize: data.fontSize,
    fontWeight: data.fontWeight,
    fontStyle: data.italic === true ? 'italic' : 'normal',
    fill: { color: hexToColorString(data.color), alpha: data.colorAlpha ?? 1 },
    align: data.align,
    // Grow the rasterized text texture past the natural line box so
    // glyphs whose descender extends below the line box (cursive g, h,
    // f, p…) don't get sliced inside Pixi's text rasterizer — without
    // this, lineHeight < ~1.1 visibly clipped descenders BEFORE our
    // container mask ever ran.
    padding: Math.ceil(data.fontSize * 0.4),
    wordWrap: true,
    wordWrapWidth: data.width,
    // Match the DOM textarea's `word-break: break-word`: also break
    // inside long unbroken runs (e.g. "asdasdasdasd…") at the box edge
    // so a typed character that wraps in DOM also wraps in Pixi —
    // otherwise the caret jumps to the next line in the textarea while
    // Pixi keeps stacking glyphs past the box and clipping them, making
    // the user's input look like it disappears.
    breakWords: true,
    letterSpacing: data.letterSpacing ?? 0,
  }
  // P15: lock Pixi's line height to a fixed 1.2× multiplier when our
  // schema doesn't set one. Pixi's auto-from-font-metrics fallback
  // produced ~1.16×, while the DOM textarea overlay uses 1.2× during
  // inline edit — that 0.04 mismatch was visible as text drifting
  // slightly down + getting taller while editing. Pinning both ends
  // to the same multiplier keeps live edit perfectly aligned with
  // the rendered text.
  opts.lineHeight =
    data.lineHeight !== undefined && data.lineHeight > 0
      ? data.lineHeight * data.fontSize
      : data.fontSize * 1.2
  if (data.stroke !== undefined && (data.strokeWidth ?? 1) > 0) {
    opts.stroke = {
      color: hexToColorString(data.stroke),
      alpha: data.strokeAlpha ?? 1,
      width: data.strokeWidth ?? 1,
    }
  }
  return new TextStyle(opts)
}

/**
 * Shift the Text node's local Y so the rendered glyph block sits at
 * top / middle / bottom of the object's bounding box.
 *
 * Uses Pixi's measured `textNode.height` so the visual bottom of the
 * last line (including descenders) lands at the box bottom for
 * vAlign='bottom' — matches what users expect from a normal text
 * editor and avoids clipping cursive descenders against the mask.
 *
 * The DOM-side TextEditOverlay reads the resulting `textNode.y` back
 * via the SceneGraph so the editing caret aligns with this exact
 * offset.
 */
function applyVerticalAlign(textNode: Text, data: TextObject): void {
  const vAlign = data.vAlign ?? 'top'
  if (vAlign === 'top') {
    textNode.y = 0
    return
  }
  const measured = textNode.height
  if (vAlign === 'middle') {
    textNode.y = Math.max(0, (data.height - measured) / 2)
  } else {
    textNode.y = Math.max(0, data.height - measured)
  }
}

/**
 * P15: explicit horizontal positioning of the Text node so left /
 * center / right align actually shift the rendered block.
 *
 * Pixi v8's `style.align` only affects per-line alignment INSIDE a
 * multi-line wrapped text — it does not move the text node within the
 * container. For single-line text shorter than wordWrapWidth, Pixi
 * collapses the rendered bounds to the line's natural width, so a
 * 'right' align with style.align alone has no visible effect.
 *
 * We use the textNode's anchor + x to position the rendered block
 * against the container's content rect (0..data.width). For
 * multi-line text the style.align field still drives the per-line
 * justification — this only handles the block's offset.
 */
function applyHorizontalAlign(textNode: Text, data: TextObject): void {
  const align = data.align ?? 'left'
  if (align === 'right') {
    textNode.anchor.x = 1
    textNode.x = data.width
  } else if (align === 'center') {
    textNode.anchor.x = 0.5
    textNode.x = data.width / 2
  } else {
    textNode.anchor.x = 0
    textNode.x = 0
  }
}

function applyObjectTransform(container: Container, data: TextObject): void {
  container.rotation = data.rotation
  container.alpha = data.opacity
  // Pivot at the object centre so rotation matches the other renderers.
  container.pivot.set(data.width / 2, data.height / 2)
  // The object's data position is the top-left corner; pivot is centre,
  // so shift the container by half-size to put the box back where it belongs.
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
}

// Pixi Container doesn't type Symbol-keyed properties — cast through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (node: Container): any => node as any

function getTextNode(node: Container): Text | undefined {
  return asAny(node)[TEXT_TAG] as Text | undefined
}

function getMask(node: Container): Graphics | undefined {
  return asAny(node)[MASK_TAG] as Graphics | undefined
}

function getUnderline(node: Container): Graphics | undefined {
  return asAny(node)[UNDERLINE_TAG] as Graphics | undefined
}

function getStoredData(node: Container): TextObject | undefined {
  return asAny(node)[DATA_TAG] as TextObject | undefined
}

function setStoredData(node: Container, data: TextObject): void {
  asAny(node)[DATA_TAG] = data
}

/**
 * Pixel allowance below the box for cursive descenders. Pixi's
 * TextStyle.padding (set in buildStyle) keeps descender pixels in the
 * rasterized texture, but the container mask still has to be a touch
 * taller than `data.height` for those pixels to show through.
 *
 * Uses Pixi's measured font descent when available, falling back to
 * 0.4 × fontSize for cursive fonts whose descent often exceeds the
 * usual 0.25 of the em.
 */
function fontDescentFor(data: TextObject): number {
  const fontSize = data.fontSize ?? 0
  if (fontSize <= 0) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const measure = (CanvasTextMetrics as any)?.measureFont as
    | ((style: TextStyle) => { descent: number })
    | undefined
  if (typeof measure === 'function') {
    try {
      const metrics = measure(buildStyle(data))
      if (typeof metrics?.descent === 'number' && metrics.descent > 0) {
        return Math.ceil(metrics.descent)
      }
    } catch {
      /* fall through to estimate */
    }
  }
  return Math.ceil(fontSize * 0.4)
}

/**
 * Draw / update / remove the underline Graphics to match
 * `data.underline`. One horizontal line per rendered text line, sitting
 * just below the baseline. Pixi v8 doesn't render underlines via
 * TextStyle, so we reproduce the effect ourselves.
 */
function applyUnderline(container: Container, textNode: Text, data: TextObject): void {
  const existing = getUnderline(container)
  if (data.underline !== true) {
    if (existing !== undefined) {
      existing.destroy()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (container as any)[UNDERLINE_TAG]
    }
    return
  }

  let g = existing
  if (g === undefined) {
    g = new Graphics()
    asAny(container)[UNDERLINE_TAG] = g
    container.addChild(g)
  }
  g.clear()

  const fontSize = data.fontSize
  const lineHeightMul = data.lineHeight !== undefined && data.lineHeight > 0 ? data.lineHeight : 1.2
  const lineHeightPx = fontSize * lineHeightMul
  const text = (textNode.text as string) ?? ''
  const lines = text.split('\n')
  const colour = hexToColorString(data.color)
  const alpha = data.colorAlpha ?? 1
  const align = data.align ?? 'left'
  const measureStyle = buildStyle(data)

  // Underline geometry uses fontSize-proportional typographic ratios
  // that match browser fallback behaviour when the font's own
  // post.underlinePosition / post.underlineThickness aren't available:
  //   - alphabetic baseline ≈ 0.78 × fontSize below the glyph cap top
  //   - underline sits ≈ 0.10 × fontSize below the baseline
  //   - thickness ≈ fontSize / 14 (matches CSS UA defaults)
  // Floats throughout so the line stays aligned even at very small
  // font sizes where Pixi's pixel-rasterized metrics would round.
  const ASCENT_RATIO = 0.78
  const DESCENT_RATIO = 0.22
  const UNDERLINE_OFFSET_RATIO = 0.1
  const UNDERLINE_THICKNESS_RATIO = 1 / 14

  const ascentPx = fontSize * ASCENT_RATIO
  const descentPx = fontSize * DESCENT_RATIO
  const halfLeading = Math.max(0, (lineHeightPx - ascentPx - descentPx) / 2)
  const baselineFromLineTop = halfLeading + ascentPx
  const underlineOffset = fontSize * UNDERLINE_OFFSET_RATIO
  const thickness = Math.max(1, fontSize * UNDERLINE_THICKNESS_RATIO)

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i] ?? ''
    if (lineText.length === 0) continue
    const lineWidth = CanvasTextMetrics.measureText(lineText, measureStyle).width

    let lineX = 0
    if (align === 'center') lineX = (data.width - lineWidth) / 2
    else if (align === 'right') lineX = data.width - lineWidth

    const yTop = textNode.y + i * lineHeightPx + baselineFromLineTop + underlineOffset
    g.rect(lineX, yTop, lineWidth, thickness)
  }
  g.fill({ color: colour, alpha })
}

/**
 * Rebuild the clip mask to cover the bounding box plus descender
 * room. Glyphs that wrap below the box still get clipped by the mask;
 * only the last line's descender survives.
 */
function applyClipMask(container: Container, data: TextObject): void {
  let mask = getMask(container)
  if (mask === undefined) {
    mask = new Graphics()
    asAny(container)[MASK_TAG] = mask
    container.addChild(mask)
    container.mask = mask
  }
  mask.clear()
  mask.rect(0, 0, data.width, data.height + fontDescentFor(data))
  mask.fill({ color: 0xffffff })
}

export const textRenderer = {
  type: 'text' as const,

  /**
   * Build a Container + Pixi Text node for the given TextObject data.
   * Container is positioned and rotated per the data; pivot is centred.
   */
  mount(data: TextObject): Container {
    const container = new Container()
    const style = buildStyle(data)
    const textNode = new Text({
      text: applyListMarkers(readPlainText(data.text), data.listStyle),
      style,
    })

    container.addChild(textNode)

    asAny(container)[TEXT_TAG] = textNode

    applyObjectTransform(container, data)
    applyHorizontalAlign(textNode, data)
    applyVerticalAlign(textNode, data)
    applyUnderline(container, textNode, data)
    applyClipMask(container, data)
    applyFilterEffects(container, data.shadow, data.blur)
    setStoredData(container, data)

    // When a TextObject mounts before the deck's custom font loads,
    // FontLoader eventually calls SceneGraph.refreshTextNodesUsingFamily()
    // which re-applies the style and clears Pixi's CanvasTextSystem cache.
    // No per-node listener needed.

    return container
  },

  /**
   * Refresh an existing Container from new data. Reuses the Text node
   * and rebuilds TextStyle only when typography fields actually changed.
   */
  update(node: Container, prev: TextObject, next: TextObject): void {
    applyObjectTransform(node, next)

    const textNode = getTextNode(node)
    if (textNode === undefined) return

    const prevText = readPlainText(prev.text)
    const nextText = readPlainText(next.text)
    if (prevText !== nextText || prev.listStyle !== next.listStyle) {
      textNode.text = applyListMarkers(nextText, next.listStyle)
    }

    const styleChanged =
      prev.fontSize !== next.fontSize ||
      prev.fontWeight !== next.fontWeight ||
      prev.color !== next.color ||
      prev.colorAlpha !== next.colorAlpha ||
      prev.align !== next.align ||
      prev.width !== next.width ||
      prev.fontFamily !== next.fontFamily ||
      prev.italic !== next.italic ||
      prev.underline !== next.underline ||
      prev.letterSpacing !== next.letterSpacing ||
      prev.lineHeight !== next.lineHeight ||
      prev.stroke !== next.stroke ||
      prev.strokeAlpha !== next.strokeAlpha ||
      prev.strokeWidth !== next.strokeWidth

    if (styleChanged) {
      textNode.style = buildStyle(next)
    }

    // Vertical alignment shifts the text node's Y inside the container.
    applyVerticalAlign(textNode, next)
    if (prev.align !== next.align || prev.width !== next.width) {
      applyHorizontalAlign(textNode, next)
    }

    applyUnderline(node, textNode, next)
    applyClipMask(node, next)

    applyFilterEffects(node, next.shadow, next.blur)
    setStoredData(node, next)
  },

  /**
   * Surgical patch update — touches only the fields named in `patch`.
   *
   * Granularity:
   * - { x | y | rotation | opacity }   → container transform only.
   * - { text } alone                   → textNode.text only.
   * - typography fields                → TextStyle rebuild via buildStyle.
   *
   * { width } in the patch affects both wordWrapWidth (TextStyle) and
   * the container pivot/position; both are applied when width is set.
   */
  applyPatch(node: Container, patch: Partial<TextObject>): void {
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

    // height change → recompute pivot.y and node.y so the box top stays put.
    if (patch.height !== undefined) {
      const dataY = node.y - node.pivot.y
      const newPivotY = patch.height / 2
      node.pivot.set(node.pivot.x, newPivotY)
      node.y = dataY + newPivotY
    }

    const textNode = getTextNode(node)
    if (textNode === undefined) return

    // Text content — if listStyle is also in patch, marker prefix must
    // be regenerated. Otherwise write raw text directly (list markers
    // already in node.text stay intact because we ignore them in Y.Doc).
    const textChanged = 'text' in patch
    const listChanged = 'listStyle' in patch

    // Any typography-affecting field forces a style rebuild. We use
    // `'X' in patch` rather than `patch.X !== undefined` because the
    // Inspector and Y.Map reconciler both express "delete this field"
    // as `{ X: undefined }` — checking `!== undefined` would silently
    // miss the delete and leave the previous style applied (e.g.
    // toggling italic off would keep glyphs italicised).
    const needsStyleRebuild =
      'fontSize' in patch ||
      'fontWeight' in patch ||
      'color' in patch ||
      'colorAlpha' in patch ||
      'align' in patch ||
      'width' in patch ||
      'fontFamily' in patch ||
      'italic' in patch ||
      'underline' in patch ||
      'letterSpacing' in patch ||
      'lineHeight' in patch ||
      'stroke' in patch ||
      'strokeAlpha' in patch ||
      'strokeWidth' in patch

    // Use the stored last-applied data as the merge base so non-Pixi
    // fields (vAlign, listStyle, font metadata) are preserved across
    // patches. mount() / update() always write to the tag, so the only
    // way it's missing is if a stale node escaped reconciliation —
    // fall back to the previous Pixi-derived synthesis in that case.
    const stored = getStoredData(node)
    const merged: TextObject =
      stored !== undefined
        ? ({ ...stored, ...patch } as TextObject)
        : (() => {
            const style = textNode.style as TextStyle
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fillRaw = style.fill as any
            const fillStr =
              typeof fillRaw === 'string'
                ? fillRaw
                : typeof fillRaw === 'object' &&
                    fillRaw !== null &&
                    typeof fillRaw.color === 'string'
                  ? fillRaw.color
                  : '#000000'
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const styleAny = style as any
            const rawFamily = styleAny.fontFamily
            const family = Array.isArray(rawFamily)
              ? rawFamily.join(', ')
              : typeof rawFamily === 'string'
                ? rawFamily
                : undefined
            const fallback: TextObject = {
              id: '',
              type: 'text',
              x: node.x - node.pivot.x,
              y: node.y - node.pivot.y,
              width: node.pivot.x * 2,
              height: node.pivot.y * 2,
              rotation: node.rotation,
              opacity: node.alpha,
              // textNode.text is already a plain string (Pixi flattens it
              // on assignment). The fallback path only runs if mount/update
              // never wrote DATA_TAG, so a string is the safe shape here.
              text: textNode.text,
              fontSize: style.fontSize as number,
              fontWeight: style.fontWeight as TextObject['fontWeight'],
              color: parseInt(fillStr.slice(1), 16),
              align: style.align as TextObject['align'],
              ...(typeof family === 'string' && family !== '' ? { fontFamily: family } : {}),
            }
            return { ...fallback, ...patch } as TextObject
          })()

    if (textChanged || listChanged || needsStyleRebuild) {
      textNode.style = buildStyle(merged)
      if (textChanged || listChanged) {
        textNode.text = applyListMarkers(readPlainText(merged.text), merged.listStyle)
      }
      if (patch.width !== undefined) {
        const dataX = node.x - node.pivot.x
        const newPivotX = patch.width / 2
        node.pivot.set(newPivotX, node.pivot.y)
        node.x = dataX + newPivotX
      }
      if (patch.align !== undefined || patch.width !== undefined) {
        applyHorizontalAlign(textNode, merged)
      }
    }

    // vAlign and the underline both depend on textNode.y / measured
    // glyph metrics, so re-run them whenever the text content, the
    // box, or any typographic field changed. Without this an
    // align-only or vAlign-only patch would leave either the text or
    // the underline at its previous position.
    const layoutAffected =
      textChanged || listChanged || needsStyleRebuild || 'vAlign' in patch || 'height' in patch
    if (layoutAffected) {
      applyVerticalAlign(textNode, merged)
      applyUnderline(node, textNode, merged)
    }

    setStoredData(node, merged)

    if ('shadow' in patch || 'blur' in patch) {
      applyFilterEffects(
        node,
        'shadow' in patch ? patch.shadow : undefined,
        'blur' in patch ? patch.blur : undefined,
      )
    }

    // Rebuild the clip mask whenever the bounding box or fontSize
    // changes — bottomPad tracks fontSize so a font-size patch must
    // refresh the mask.
    if (patch.width !== undefined || patch.height !== undefined || patch.fontSize !== undefined) {
      applyClipMask(node, merged)
    }
  },

  /**
   * Release the Text node, mask, underline and container. Called when
   * the object is removed from the slide.
   */
  destroy(node: Container): void {
    const textNode = getTextNode(node)
    textNode?.destroy()
    const mask = getMask(node)
    if (mask !== undefined) {
      node.mask = null
      mask.destroy()
    }
    getUnderline(node)?.destroy()
    destroyFilterEffects(node)
    node.destroy()
  },
}
