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

import { CanvasTextMetrics, Container, Graphics, HTMLText, HTMLTextStyle, TextStyle } from 'pixi.js'
import * as Y from 'yjs'
import { toDelta, toHtml, type HtmlDefaults } from '@narrative/slide-model'
import type { TextObject } from '../types'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { applyFlip } from './applyFlip.js'
import { resolveColour } from '../colourResolver.js'

/**
 * Pixi v8 `HTMLText` rasterizes its SVG asynchronously
 * (`HTMLTextPipe._updateGpuText` awaits an image-load Promise). The
 * scene-graph render scheduler runs with `autoStart: false` and fires
 * exactly one frame per `applyChanges()` call — by the time the SVG
 * texture finishes loading, that frame has already been drawn and no
 * follow-up render is queued. The text never appears.
 *
 * Mirror what image/video renderers do: poke the scheduler whenever the
 * HTMLText node invalidates itself, including when its texture lands.
 * `onViewUpdate` is Pixi's per-instance hook that fires for any
 * structural change (text, style, transform, texture-ready). One
 * follow-up `markRenderDirty()` per invalidation is enough.
 */
/**
 * Schedule a small follow-up render on a per-node basis so the async
 * SVG→texture upload has a frame to land into. Deduped — if a cascade
 * is already in flight for this node, do nothing. Capped to 3 rAFs
 * which empirically covers Pixi's worst-case rasterise window without
 * burning CPU during steady-state animation/typing.
 */
function scheduleAsyncTextureCatchup(node: { __narrativeCatchupActive?: boolean }): void {
  if (node.__narrativeCatchupActive === true) return
  node.__narrativeCatchupActive = true
  let n = 0
  const tick = (): void => {
    markRenderDirty()
    if (n < 2) {
      n += 1
      requestAnimationFrame(tick)
    } else {
      node.__narrativeCatchupActive = false
    }
  }
  requestAnimationFrame(tick)
}

/**
 * Patch `onViewUpdate` so a real text/style invalidation triggers a
 * single deduped render cascade. We compare `styleKey` + `text`
 * before/after and only schedule when something actually changed —
 * this skips the per-frame onViewUpdate calls Pixi makes during a
 * GSAP transform animation, which previously had us scheduling
 * dozens of rAF wake-ups every second.
 */
function wireRedrawOnAsyncTextureUpdate(textNode: HTMLText): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node = textNode as any
  if (typeof node.onViewUpdate !== 'function') return
  if (node.__narrativeRedrawWired === true) return
  const original = node.onViewUpdate.bind(node)
  node.onViewUpdate = function patched(this: unknown, ...args: unknown[]) {
    const prevKey = node.__narrativeLastKey
    const prevText = node.__narrativeLastText
    original(...args)
    const nextKey = node.styleKey
    const nextText = node.text
    if (prevKey !== nextKey || prevText !== nextText) {
      node.__narrativeLastKey = nextKey
      node.__narrativeLastText = nextText
      scheduleAsyncTextureCatchup(node)
    }
  }
  node.__narrativeRedrawWired = true
}

/**
 * Render the text body to an HTML string suitable for `Pixi.HTMLText`.
 *
 * Per-run formatting (italic / underline / fontWeight / color) is
 * encoded as `<i>`, `<u>`, and `<span style="…">` wrappers via the
 * `toHtml` helper. Box-wide defaults from the TextObject layout
 * (italic / underline / fontWeight / color) are passed through so a
 * run with no override inherits them. List markers (bullet / numbered)
 * are prepended as plain text — they live in the rendered HTML, not
 * in Y.Text.
 *
 * Legacy plain-string text (decks predating Phase A) is HTML-escaped
 * and rendered as a single run.
 */
function buildHtml(data: TextObject): string {
  // Defaults handed to toHtml only carry the field types that need
  // structural HTML (i.e. <i> / <u>). Pixi's TextStyle applies the
  // default fontWeight + color directly on the SVG root, and per-run
  // overrides from Y.Text format attributes are emitted as inline
  // styles inside <span>.
  const defaults: HtmlDefaults = {}
  if (data.italic === true) defaults.italic = true
  if (data.underline === true) defaults.underline = true
  const t = data.text
  if (t instanceof Y.Text) {
    const delta = toDelta(t)
    const html = toHtml(delta, defaults)
    return prependListMarkersHtml(html, data.listStyle)
  }
  // Legacy string — escape and pass through the same toHtml renderer
  // so the inherited defaults still apply.
  const escaped = (typeof t === 'string' ? t : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const html = toHtml([{ insert: escaped }], defaults)
  return prependListMarkersHtml(html, data.listStyle)
}

/**
 * Prepend list markers (• / 1. / 2. …) to each line break in an HTML
 * string. Markers are inserted as plain text — they aren't part of
 * Y.Text content so editing doesn't have to strip them.
 */
function prependListMarkersHtml(html: string, style: TextObject['listStyle']): string {
  if (style === undefined) return html
  const lines = html.split(/<br\s*\/?>(?![^<]*>)/i)
  if (style === 'bullet') {
    return lines.map((l) => (l.length > 0 ? `•&nbsp;&nbsp;${l}` : l)).join('<br>')
  }
  let n = 1
  return lines
    .map((l) => {
      if (l.length === 0) return l
      const out = `${n}.&nbsp;&nbsp;${l}`
      n += 1
      return out
    })
    .join('<br>')
}

/** Tag for the Pixi Text node stored on its parent Container. */
const TEXT_TAG = Symbol('textNode')
/** Tag for the clip-mask Graphics that crops glyphs to the box. */
const MASK_TAG = Symbol('textMask')
/** Last applied data snapshot — applyPatch merges against this so
 *  fields Pixi doesn't track natively (vAlign, listStyle, fontFamily)
 *  survive patches that only touch a sibling field. Without it,
 *  `{ align: 'right' }` would silently reset vAlign back to 'top'. */
const DATA_TAG = Symbol('textData')

function hexToColorString(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

/**
 * Return a CSS color string accepted by `HTMLTextStyle.fill`.
 * When alpha is 1 (fully opaque) a 6-digit hex string is returned.
 * When alpha < 1 an 8-digit CSS `#RRGGBBAA` hex is returned so that
 * the transparency is encoded without relying on the `{color, alpha}`
 * object form that `HTMLTextStyle` does not support.
 */
function colorWithAlpha(hex: number, alpha: number): string {
  const base = hexToColorString(hex)
  if (alpha >= 1) return base
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  return base + a.toString(16).padStart(2, '0')
}

/**
 * Walk Y.Text deltas and collect every distinct `fontFamily` attribute
 * present on any run. Used to feed Pixi's `extractFontFamilies` via the
 * box-level style array so per-run inline `<span style="font-family:X">`
 * markers reliably get an embedded `@font-face` rule in the rasterised
 * SVG — without depending on Pixi's text-scraping regex, which breaks
 * on family names containing whitespace.
 */
function collectRunFontFamilies(data: TextObject): string[] {
  const t = data.text
  if (!(t instanceof Y.Text)) return []
  const delta = toDelta(t)
  const set = new Set<string>()
  for (const op of delta) {
    const fam = op.attributes?.['fontFamily']
    if (typeof fam === 'string' && fam !== '') set.add(fam)
  }
  return [...set]
}

/**
 * Plain-object style options used both by the canonical `TextStyle`
 * (for measurement / underline maths historically, and the fallback
 * synthesis path in applyPatch) and by the live HTMLText node. We
 * keep the field set in one place to guarantee the two stay in sync.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi TextStyle options loosely typed
function buildStyleOpts(data: TextObject): any {
  // Pixi v8 HTMLText's `extractFontFamilies` reads `style.fontFamily`
  // and adds every entry of an Array directly to the @font-face embed
  // list. Per-run families inserted via inline `<span>` only get picked
  // up via a fragile regex (`font-family:([^;"\s]+)`) that drops
  // anything past whitespace, so a family name like "Roboto Condensed"
  // would never embed and the SVG would silently fall back to system.
  // Compose an explicit array of [box, ...runs] so each run-level
  // family produces a real @font-face inside the SVG.
  const boxFamily = data.fontFamily ?? 'system-ui, -apple-system, sans-serif'
  const runFamilies = collectRunFontFamilies(data)
  const familyArray =
    runFamilies.length > 0 ? Array.from(new Set([boxFamily, ...runFamilies])) : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = {
    // Pixi v8's `fontStringFromTextStyle` auto-quotes unquoted multi-
    // word family names (anything not in the CSS generic set), so we
    // can pass `data.fontFamily` straight through. When run-level
    // families exist we pass an array so all of them get embedded.
    fontFamily: familyArray ?? boxFamily,
    fontSize: data.fontSize,
    fontWeight: data.fontWeight,
    fontStyle: data.italic === true ? 'italic' : 'normal',
    fill: colorWithAlpha(resolveColour(data.color), data.colorAlpha ?? 1),
    align: data.align,
    // Pixi.HTMLText renders via an SVG foreignObject, so descenders
    // are never clipped by a texture boundary — TextStyle.padding (used
    // by canvas-rasterised Pixi.Text) is unnecessary here AND actively
    // harmful: HTMLText shifts its render origin by `padding` on both
    // axes, which would push the text outside the slide-coord box
    // we draw at (0,0).
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
      color: hexToColorString(resolveColour(data.stroke)),
      alpha: data.strokeAlpha ?? 1,
      width: data.strokeWidth ?? 1,
    }
  }
  return opts
}

/** Convenience wrapper used where a real TextStyle instance is needed. */
function buildStyle(data: TextObject): TextStyle {
  return new TextStyle(buildStyleOpts(data))
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
function applyVerticalAlign(textNode: HTMLText, data: TextObject): void {
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
function applyHorizontalAlign(textNode: HTMLText, data: TextObject): void {
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
  applyFlip(container, data)
}

// Pixi Container doesn't type Symbol-keyed properties — cast through any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (node: Container): any => node as any

function getTextNode(node: Container): HTMLText | undefined {
  return asAny(node)[TEXT_TAG] as HTMLText | undefined
}

function getMask(node: Container): Graphics | undefined {
  return asAny(node)[MASK_TAG] as Graphics | undefined
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
/**
 * Memoise font descent measurement keyed on the visually-relevant style
 * fields. `CanvasTextMetrics.measureFont` rasterises a probe canvas and
 * is genuinely expensive — without a cache we paid for it on every
 * `applyClipMask` call (which runs from `update()` / `applyPatch()` for
 * every reconciler tick, including transient transform-only patches).
 */
const fontDescentCache = new Map<string, number>()
function fontDescentFor(data: TextObject): number {
  const fontSize = data.fontSize ?? 0
  if (fontSize <= 0) return 0
  const key = `${data.fontFamily ?? ''}|${fontSize}|${data.fontWeight}|${data.italic === true ? 1 : 0}`
  const cached = fontDescentCache.get(key)
  if (cached !== undefined) return cached
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const measure = (CanvasTextMetrics as any)?.measureFont as
    | ((style: TextStyle) => { descent: number })
    | undefined
  let descent = Math.ceil(fontSize * 0.4)
  if (typeof measure === 'function') {
    try {
      const metrics = measure(buildStyle(data))
      if (typeof metrics?.descent === 'number' && metrics.descent > 0) {
        descent = Math.ceil(metrics.descent)
      }
    } catch {
      /* keep estimate */
    }
  }
  fontDescentCache.set(key, descent)
  return descent
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
    const textNode = new HTMLText({
      text: buildHtml(data),
      style: new HTMLTextStyle(buildStyleOpts(data)),
    })

    container.addChild(textNode)

    asAny(container)[TEXT_TAG] = textNode
    wireRedrawOnAsyncTextureUpdate(textNode)
    // The HTMLText constructor fires onViewUpdate synchronously BEFORE
    // we patch it above, so the very first SVG→texture rasterise is
    // not covered by the wired catchup. On slide switch the single
    // applyChanges-driven render frame can fire before that texture
    // lands → blank text until the next unrelated invalidation. Force
    // one catchup cascade on mount so the new node always gets a few
    // follow-up frames to pick up its first texture.
    scheduleAsyncTextureCatchup(textNode as unknown as { __narrativeCatchupActive?: boolean })

    applyObjectTransform(container, data)
    applyHorizontalAlign(textNode, data)
    applyVerticalAlign(textNode, data)
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

    // Always rebuild the HTML — Y.Text format changes don't surface as
    // a `prev` / `next` field diff (they live inside the same Y.Text
    // instance). The cost is one HTML string concatenation per update;
    // Pixi's HTMLText only re-rasterises when the string actually
    // differs.
    textNode.text = buildHtml(next)

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
      textNode.style = new HTMLTextStyle(buildStyleOpts(next))
    }

    applyVerticalAlign(textNode, next)
    if (prev.align !== next.align || prev.width !== next.width) {
      applyHorizontalAlign(textNode, next)
    }

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
      textNode.style = new HTMLTextStyle(buildStyleOpts(merged))
      // The HTML always tracks the merged data — text changes,
      // listStyle, italic / underline / weight defaults all affect
      // the emitted markup.
      textNode.text = buildHtml(merged)
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

    // vAlign depends on textNode.y / measured glyph metrics — re-run
    // whenever the text content, the box, or any typographic field
    // changed (anything that can shift the rendered block).
    const layoutAffected =
      textChanged || listChanged || needsStyleRebuild || 'vAlign' in patch || 'height' in patch
    if (layoutAffected) {
      applyVerticalAlign(textNode, merged)
    }

    setStoredData(node, merged)

    if ('shadow' in patch || 'blur' in patch) {
      applyFilterEffects(node, merged.shadow, merged.blur)
    }

    // Rebuild the clip mask whenever the bounding box or fontSize
    // changes — bottomPad tracks fontSize so a font-size patch must
    // refresh the mask.
    if (patch.width !== undefined || patch.height !== undefined || patch.fontSize !== undefined) {
      applyClipMask(node, merged)
    }
  },

  /**
   * Release the Text node, mask, and container. Called when the object
   * is removed from the slide.
   */
  destroy(node: Container): void {
    const textNode = getTextNode(node)
    textNode?.destroy()
    const mask = getMask(node)
    if (mask !== undefined) {
      node.mask = null
      mask.destroy()
    }
    destroyFilterEffects(node)
    node.destroy()
  },
}
