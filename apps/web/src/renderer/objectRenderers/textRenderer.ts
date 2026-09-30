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

// Must run before any HTMLText is measured: scopes the CSS Pixi injects into
// document.body during measurement so it cannot restyle the rest of the page.
import '../pixiHtmlTextStyleScope.js'
import { CanvasTextMetrics, Container, Graphics, HTMLText, HTMLTextStyle } from 'pixi.js'
import type { TextStyle } from 'pixi.js'
import {
  resolveLineHeightPx,
  forgetMeasuredLineHeight,
  powerpointLineOffsetPx,
} from '../../lib/fontLineMetrics.js'
import {
  firstLineFontSizePx,
  largestFontSizePx,
  listedHtmlOptionsFor,
  paragraphsOf,
} from '../../lib/textLayout.js'
import * as Y from 'yjs'
import { toDelta, toHtml, buildListedHtml, type HtmlDefaults } from '@narrative/slide-model'
import type { TextObject } from '../types'
import { applyFilterEffects, destroyFilterEffects } from '../filterEffects.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { applyFlip } from './applyFlip.js'
import { resolveColour } from '../colourResolver.js'
import { cssFontFamily } from '../fontFallback.js'
import { getRenderingSlideNumber } from '../slideNumberContext.js'

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
/**
 * Exported for cross-renderer reuse — the table renderer mounts a
 * per-cell HTMLText that shares the same async lifecycle handling as
 * the main text-object renderer. Internal otherwise.
 */
export function scheduleAsyncTextureCatchup(node: {
  __narrativeCatchupActive?: boolean
  destroyed?: boolean
}): void {
  // A destroy() call walks Pixi's child tree and fires `unload` on
  // every renderable, which routes through the patched onViewUpdate
  // below. Without this guard we'd schedule a rAF render against a
  // node whose texture source is already freed — the next paint then
  // hits `texSubImage2D` with a zero-sized image and the glyphs come
  // back as black rectangles (the WebGL INVALID_VALUE in the logs).
  if (node.destroyed === true) return
  if (node.__narrativeCatchupActive === true) return
  node.__narrativeCatchupActive = true
  let n = 0
  const tick = (): void => {
    if (node.destroyed === true) {
      node.__narrativeCatchupActive = false
      return
    }
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
/** @see scheduleAsyncTextureCatchup — same export rationale. */
export function wireRedrawOnAsyncTextureUpdate(textNode: HTMLText): void {
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
      reflagAfterInFlightRaster(node)
    }
  }
  node.__narrativeRedrawWired = true
}

/**
 * Pixi's HTMLTextPipe loses a change that lands while it is still
 * rasterising the previous one: `_updateGpuText` clears the node's dirty
 * flag first and only then returns early because a texture is being
 * generated, and once that texture arrives nothing compares `currentKey`
 * with `styleKey` again. The node then draws the old texture under bounds
 * computed for the new style — a 32px "Sell" floating above where the
 * 160px one belongs — until some unrelated write to it. One text in five
 * patched right after it was added ended up like this.
 *
 * So when a change arrives mid-generation, wait for that generation and,
 * if the key has moved on in the meantime, flag the node again. Pixi's own
 * continuation runs first (it registered on the promise before us) and
 * has cleared `generatingTexture` by then, so the re-flag goes through.
 */
interface InFlightGpuText {
  generatingTexture?: boolean
  texturePromise?: Promise<unknown> | null
  currentKey?: string
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function reflagAfterInFlightRaster(node: any): void {
  const gpuData = node._gpuData as Record<string, InFlightGpuText> | undefined
  if (gpuData === undefined) return
  for (const gpu of Object.values(gpuData)) {
    if (gpu.generatingTexture !== true || !gpu.texturePromise) continue
    gpu.texturePromise.then(
      () => {
        if (node.destroyed === true || gpu.currentKey === node.styleKey) return
        node._didTextUpdate = true
        node.onViewUpdate()
      },
      () => {
        /* the failed generation is Pixi's to report; nothing to follow up */
      },
    )
  }
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
/** Exported for the table renderer — same HTML build pipeline for cells. */
export function buildHtml(data: TextObject): string {
  let inner: string
  if (data.isSlideNumber === true) {
    // Page-number field — render the live deck index for the slide
    // currently being painted. Stored `text` content is intentionally
    // ignored; only style fields apply. When no slide context is
    // available (e.g. the master editor with no host slide, or a
    // skipped slide) we render an empty string so the user still sees
    // their styled box. Slide-number fields never carry list structure.
    const n = getRenderingSlideNumber()
    const value = typeof n === 'number' ? String(n) : ''
    const defaults: HtmlDefaults = {}
    if (data.italic === true) defaults.italic = true
    if (data.underline === true) defaults.underline = true
    inner = toHtml([{ insert: value }], defaults)
  } else {
    // Both Y.Text and legacy-string bodies render through the shared
    // paragraph/list builder so per-paragraph bullets, numbering, nesting
    // indent, and paragraph spacing are produced identically here and in
    // the edit overlay.
    inner = buildListedHtml(paragraphsOf(data), listedHtmlOptionsFor(data))
  }
  // Visual case transform — wrap in a span with the corresponding CSS
  // so the underlying text stays editable in its original casing while
  // the rendered SVG glyphs reflect the transform. Pixi.HTMLText uses
  // SVG foreignObject, so HTML+CSS works.
  const tt = data.textTransform
  if (tt === 'uppercase' || tt === 'lowercase' || tt === 'capitalize') {
    return `<span style="text-transform:${tt}">${inner}</span>`
  }
  return inner
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
// Unused after the switch to a CSS-quoted string (R2-mini font fix).
// Kept so future work that wants per-run @font-face embeds has the
// helper handy; remove if it gets stale.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

/** Exported for the table renderer — same HTMLTextStyle options builder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildStyleOpts(data: TextObject): any {
  // Pixi v8 HTMLText is doing two distinct things with `style.fontFamily`:
  //
  //  1. `extractFontFamilies(text, style)` reads the value and uses it
  //     as the EXACT key into the asset Cache to find an `@font-face`
  //     entry to embed in the SVG. When it's an Array, each entry is
  //     used as its own key; when it's a string, the WHOLE string
  //     (commas + spaces + quotes and all) is one key.
  //
  //  2. `textStyleToCSS(style)` interpolates the value verbatim into
  //     the SVG's `font-family:` CSS rule via `${style.fontFamily}` —
  //     no quoting, no validation.
  //
  // FolderFontLoader registers our uploaded fonts in the cache under
  // the BARE family name (e.g. `Northwind Sans ST Pro 60 Black-and-url`).
  // To make the cache lookup hit we must pass the bare name as
  // `style.fontFamily`. But the bare name isn't valid CSS verbatim
  // when it contains digits (e.g. `60`) or whitespace — the CSS
  // tokeniser sees `Northwind Sans ST Pro 60 Black` as five identifiers
  // followed by a number followed by an identifier, which can't form
  // a single family-name value, so the rule is dropped and the
  // browser falls back to its system default.
  //
  // The two-step trick: bare name for the cache lookup, then layer
  // `cssOverrides` with a CSS-safe quoted form to win the cascade for
  // the actual rendering rule. Later declarations override earlier
  // ones inside the same `<style>` block, so the override is what the
  // SVG renderer applies.
  //
  // Per-run fontFamily values land in the inline `<span style="font-
  // family:X">` markup (richText.toHtml) — those feed Pixi's
  // `extractFontFamilies` regex separately; the run-level CSS in the
  // inline span needs no override because the browser falls back to
  // the box font (with our overridden stack) when a per-run font is
  // missing.
  const rawFamily = typeof data.fontFamily === 'string' ? data.fontFamily.trim() : ''
  const cssStack =
    cssFontFamily(data.fontFamily) ?? 'Arial, Helvetica, "Helvetica Neue", "Segoe UI", sans-serif'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts: any = {
    // Bare family name → matches Pixi's cache key for embedded
    // `@font-face` lookups. Single-ident families (e.g. `Inter`) render
    // correctly even without the override; multi-word + digit families
    // (e.g. `Northwind Sans ST Pro 60 Black`) get their CSS fixed by
    // the cssOverrides entry below.
    fontFamily: rawFamily.length > 0 ? rawFamily : 'Arial',
    fontSize: data.fontSize,
    fontWeight: data.fontWeight,
    fontStyle: data.italic === true ? 'italic' : 'normal',
    fill: colorWithAlpha(resolveColour(data.color), data.colorAlpha ?? 1),
    align: data.align,
    // Room in the rasterised texture for ink outside the line boxes.
    //
    // HTMLText draws through an SVG whose height is the sum of the line
    // boxes, and the SVG viewport clips: with a line height below the
    // font's own ascent + descent, the glyphs stick out of their line box
    // and the first line's overhang is simply not in the texture — the top
    // of a capital S cut straight across, worse the lower the line height.
    // No mask could bring it back. `padding` is Pixi's answer: the outer
    // div gets that much CSS padding, the texture grows by twice it, and
    // the quad is drawn `padding` up and left so the content stays at the
    // node's origin. Measurement subtracts it again, so `textNode.height`
    // is still the content height everything below relies on. The same
    // allowance is what the clip mask opens above and below the box.
    padding: lineOvershootFor(data),
    // `wrap: 'none'` lays each line out at its natural width; the box then
    // only anchors it (see applyHorizontalAlign) and the mask follows it.
    wordWrap: data.wrap !== 'none',
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
  // One resolver for the renderer, the edit overlay, the clip mask and the
  // Inspector: `lineHeight` (× font size) wins, else `lineSpacing` (× the
  // font's measured normal line height, PowerPoint's meaning), else the
  // font's normal. Pinning a single px value here keeps the DOM overlay and
  // Pixi's SVG rasterisation on the same line boxes while editing.
  opts.lineHeight = resolveLineHeightPx(data)
  if (data.stroke !== undefined && (data.strokeWidth ?? 1) > 0) {
    opts.stroke = {
      color: hexToColorString(resolveColour(data.stroke)),
      alpha: data.strokeAlpha ?? 1,
      width: data.strokeWidth ?? 1,
    }
  }
  // Override the auto-generated `font-family:` rule with the CSS-safe
  // quoted + fallback-stacked form. See the long comment near `rawFamily`
  // above for why this trick is necessary. Pixi v8's HTMLTextStyle
  // appends `cssOverrides` after the auto-generated declarations, so
  // the later override wins the cascade.
  // Pixi's HTMLText SVG foreignObject uses `max-width` (from
  // wordWrapWidth) which lets the inline-block container be narrower
  // than the limit. This changes how the browser distributes subpixel
  // remainders across wrapped lines compared to the contenteditable
  // overlay (which uses a fixed `width: 100%`). The mismatch compounds
  // across lines — the last characters get wrapped to a clipped line.
  // Force a fixed `width` matching the contenteditable so both
  // renderers use the same text layout algorithm.
  opts.cssOverrides = [
    `font-family: ${cssStack}`,
    // Wrapping text is laid out at exactly the box width; unwrapped text at
    // its own width, with no break opportunity but explicit line breaks.
    ...(data.wrap === 'none'
      ? [`white-space: pre`]
      : [`width: ${data.width}px`, `overflow-wrap: break-word`]),
    // Pixi measures the text in a div appended to the page, where the
    // app's preflight makes every element `border-box`, and rasterises it
    // in a detached SVG document where the same div is `content-box`. With
    // `padding` set the two disagree on the wrap width by twice the padding:
    // the measurement wraps a line earlier than the render, and the node's
    // height is one line box wrong. Say which model the rule means.
    `box-sizing: content-box`,
  ]
  return opts
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
export function applyVerticalAlign(textNode: HTMLText, data: TextObject): void {
  const vAlign = data.vAlign ?? 'top'
  const measured = textNode.height
  const block =
    vAlign === 'top'
      ? 0
      : vAlign === 'middle'
        ? Math.max(0, (data.height - measured) / 2)
        : Math.max(0, data.height - measured)
  // Then place the lines inside their boxes the way PowerPoint does — spare
  // line height above the glyphs, not split around them. The block's height
  // is unchanged, so this is a translation after alignment, not part of it.
  textNode.y = block + powerpointLineOffsetPx(data, firstLineFontSizePx(data))
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
export function applyHorizontalAlign(textNode: HTMLText, data: TextObject): void {
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
 * Memoise font ascent/descent measurement keyed on the visually-relevant style
 * fields. `CanvasTextMetrics.measureFont` rasterises a probe canvas and
 * is genuinely expensive — without a cache we paid for it on every
 * `applyClipMask` call (which runs from `update()` / `applyPatch()` for
 * every reconciler tick, including transient transform-only patches).
 */
const fontMetricsCache = new Map<string, { ascent: number; descent: number }>()
// A measurement taken before a webfont has loaded describes the fallback
// face. Forget everything once fonts finish loading so the next mask build
// measures the real one.
if (typeof document !== 'undefined' && typeof document.fonts?.addEventListener === 'function') {
  document.fonts.addEventListener('loadingdone', () => fontMetricsCache.clear())
}
/**
 * Drop the cached metrics of one family. The folder-font loader installs a
 * face that is already loaded, and `document.fonts` fires no `loadingdone`
 * for a face that never went through its loading state — so without this
 * the fallback's numbers would outlive the fallback.
 */
export function forgetFontMetrics(family: string): void {
  const prefix = `${family}|`
  for (const key of fontMetricsCache.keys()) {
    if (key.startsWith(prefix)) fontMetricsCache.delete(key)
  }
}
function fontMetricsFor(data: TextObject): { ascent: number; descent: number } {
  const fontSize = data.fontSize ?? 0
  if (fontSize <= 0) return { ascent: 0, descent: 0 }
  const key = `${data.fontFamily ?? ''}|${fontSize}|${data.fontWeight}|${data.italic === true ? 1 : 0}`
  const cached = fontMetricsCache.get(key)
  if (cached !== undefined) return cached
  // Pixi's `measureFont` takes a CSS font shorthand, not a TextStyle. Handing
  // it the style object stringified to something the canvas could not parse,
  // so it silently measured the default 10px face: ascent 10, descent 2, for
  // a 158px heading. Every allowance computed from these — the descender room
  // under the mask, and now the overhang above it — was therefore about a
  // fifteenth of what it should be, which is why a tall glyph lost its top.
  const family = (data.fontFamily ?? 'sans-serif').includes(' ')
    ? `"${data.fontFamily ?? 'sans-serif'}"`
    : (data.fontFamily ?? 'sans-serif')
  const weight = data.fontWeight ?? 400
  const shorthand = `${data.italic === true ? 'italic ' : ''}${weight} ${fontSize}px ${family}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const measure = (CanvasTextMetrics as any)?.measureFont as
    | ((font: string) => { ascent: number; descent: number })
    | undefined
  const out = { ascent: Math.ceil(fontSize * 1.0), descent: Math.ceil(fontSize * 0.4) }
  if (typeof measure === 'function') {
    try {
      const metrics = measure(shorthand)
      if (typeof metrics?.ascent === 'number' && metrics.ascent > 0) {
        out.ascent = Math.ceil(metrics.ascent)
      }
      if (typeof metrics?.descent === 'number' && metrics.descent > 0) {
        out.descent = Math.ceil(metrics.descent)
      }
    } catch {
      /* keep estimates */
    }
  }
  fontMetricsCache.set(key, out)
  return out
}

/**
 * How far the glyphs spill outside their own line boxes, per edge.
 *
 * A line box is `lineHeight` tall, but the ink in it is `ascent + descent`.
 * When the line height is the smaller of the two — which a PowerPoint
 * `<a:lnSpc><a:spcPct val="75000"/>` gives you, and which is exactly how the
 * word "Sell" is set on the reported slide — CSS splits the shortfall evenly
 * above and below as negative half-leading, and the glyphs simply stick out.
 * The first line's ink then starts *above* the text node's own origin.
 *
 * Two things used to shave that overhang, and both are sized by this number:
 * the mask began at y=0, and — the one that survived the mask fix — the SVG
 * Pixi rasterises the text through was exactly the line boxes tall, so the
 * ink above the first one never made it into the texture (see `padding` in
 * `buildStyleOpts`). It showed correctly while editing because the DOM
 * overlay draws with neither, and reverted the moment you left the editor —
 * which is what made it look like an editing bug rather than a clipping one.
 */
export function lineOvershootFor(data: TextObject): number {
  const fontSize = data.fontSize ?? 0
  if (fontSize <= 0) return 0
  // The overhang grows with the font; the largest one on any line is the
  // one that reaches furthest (a line is spaced for its own fonts).
  const largest = largestFontSizePx(data)
  const frame = fontMetricsFor(data)
  const ascent = (frame.ascent * largest) / fontSize
  const descent = (frame.descent * largest) / fontSize
  const lineHeightPx = resolveLineHeightPx(data, largest)
  // Canvas metrics report the font's nominal ascent; round glyphs and
  // accents overshoot it, and a face measured before its webfont arrived
  // reports a fallback's numbers. A quarter em on top is cheap — it is
  // texture rows and mask rows, nothing the eye sees — and means a
  // slightly-off metric cannot shave a glyph. This one number sizes both
  // the texture's padding and the mask's reach, so they cannot disagree.
  const halfLeadingOverhang = Math.max(0, (ascent + descent - lineHeightPx) / 2)
  return Math.ceil(halfLeadingOverhang + largest * OVERHANG_MARGIN_EM)
}

/** Extra vertical room above and below the text, as a fraction of the em. */
const OVERHANG_MARGIN_EM = 0.25

/**
 * Rebuild the clip mask.
 *
 * The mask covers the box's width — text must not bleed sideways — but its
 * height follows whichever is taller, the box or the text actually in it.
 *
 * It used to be the box height flat, which silently truncated any text that
 * did not fit: an imported slide whose frame PowerPoint had auto-sized to its
 * own line spacing lost its last line mid-glyph here. PowerPoint never clips
 * an overflowing text frame — it draws the text past the shape — so clipping
 * it is a fidelity bug and, worse, one that hides content rather than
 * showing it wrong. A box whose text fits is unaffected: the two heights are
 * the same and the mask is exactly where it always was.
 */
function applyClipMask(container: Container, data: TextObject): void {
  let mask = getMask(container)
  if (mask === undefined) {
    mask = new Graphics()
    asAny(container)[MASK_TAG] = mask
    container.addChild(mask)
    container.mask = mask
  }
  const node = getTextNode(container)
  // `textNode.height` is 0 until the first rasterisation lands; fall back to
  // the box so a not-yet-measured node is not masked away entirely.
  const measured = node !== undefined && node.height > 0 ? node.height : 0
  const contentHeight = Math.max(data.height, measured + (node?.y ?? 0))
  // The same allowance above and below as the texture's own padding: the
  // mask admits exactly what the texture can hold, no more (anything
  // further out is not in the texture) and no less (that was the cut).
  const overshoot = lineOvershootFor(data)
  // Line spacing below 100% moves the text up (negative PowerPoint offset),
  // so its first line can start above the box; open the mask that far too.
  const top = Math.min(0, node?.y ?? 0) - overshoot
  const bottom = contentHeight + overshoot
  // Text must not bleed sideways out of a wrapping box. Unwrapped text is
  // meant to: PowerPoint draws a `wrap="none"` line past the box on the side
  // its alignment grows towards, so the mask spans the line where it is.
  let left = 0
  let right = data.width
  if (data.wrap === 'none' && node !== undefined && node.width > 0) {
    const nodeLeft = node.x - node.anchor.x * node.width
    left = Math.min(0, nodeLeft) - overshoot
    right = Math.max(data.width, nodeLeft + node.width) + overshoot
  }
  mask.clear()
  mask.rect(left, top, right - left, bottom - top)
  mask.fill({ color: 0xffffff })
}

/**
 * Shared mount body. The `wireCatchup` flag controls whether the new
 * HTMLText invalidations should poke the main-scene RenderScheduler.
 * The main editor wants this on (HTMLText rasterizes its SVG async, so
 * the first frame after slide switch may catch the texture mid-load).
 * The thumbnail pipeline wants it OFF — its renderer is offscreen and
 * uses `texturePromise` + a second `app.renderer.render()` to wait for
 * the rasterise; cross-context dirty-flagging through the main
 * scheduler corrupts the upload.
 */
// ---------------------------------------------------------------------------
// Per-node HTML cache-busting
// ---------------------------------------------------------------------------
//
// Pixi v8's HTMLText pipeline caches its rasterised SVG textures keyed
// by the HTML string. Two HTMLText nodes with byte-identical content
// therefore share one cached entry — usually fine, but when one of
// them re-rasterises (font load, style edit, resize) the other can
// briefly read a stale or already-evicted texture object and render
// the wrong glyphs. In a deck this surfaces as duplicate component
// instances whose headline disappears, swaps with the body content,
// or briefly shows another text node's content.
//
// We force per-node cache-key uniqueness by prefixing the HTML with an
// invisible HTML comment that contains the HTMLText's pixi `uid` —
// every Container has a readonly numeric uid that's unique within the
// process and stable for the node's lifetime. The comment doesn't
// affect SVG layout, and because the uid is stable, Pixi's
// "rasterise only when string differs" optimisation still kicks in
// when the actual content of THIS node hasn't changed.
//
// This is a userland workaround for a Pixi-internal cache aliasing
// issue; the proper fix lives upstream. Until they tighten the cache
// key, a per-node uid prefix is the cheapest deterministic guarantee
// that two HTMLText nodes cannot share a backing texture.
function buildHtmlForNode(textNode: HTMLText, data: TextObject): string {
  return `<!--n:${textNode.uid}-->${buildHtml(data)}`
}

function mountTextContainer(data: TextObject, opts: { wireCatchup: boolean }): Container {
  const container = new Container()
  const textNode = new HTMLText({
    text: '',
    style: new HTMLTextStyle(buildStyleOpts(data)),
  })
  // Set after construction so the per-node uid is allocated against
  // this specific HTMLText instance — keeps the cache key unique even
  // when two nodes carry byte-identical user content.
  textNode.text = buildHtmlForNode(textNode, data)

  container.addChild(textNode)

  asAny(container)[TEXT_TAG] = textNode
  if (opts.wireCatchup) {
    wireRedrawOnAsyncTextureUpdate(textNode)
    // The HTMLText constructor fires onViewUpdate synchronously BEFORE
    // we patch it above, so the very first SVG→texture rasterise is
    // not covered by the wired catchup. On slide switch the single
    // applyChanges-driven render frame can fire before that texture
    // lands → blank text until the next unrelated invalidation. Force
    // one catchup cascade on mount so the new node always gets a few
    // follow-up frames to pick up its first texture.
    scheduleAsyncTextureCatchup(textNode as unknown as { __narrativeCatchupActive?: boolean })
  }

  applyObjectTransform(container, data)
  applyHorizontalAlign(textNode, data)
  applyVerticalAlign(textNode, data)
  applyClipMask(container, data)
  applyFilterEffects(container, data.shadow, data.blur)
  setStoredData(container, data)

  return container
}

export const textRenderer = {
  type: 'text' as const,

  /**
   * Build a Container + Pixi Text node for the given TextObject data.
   * Container is positioned and rotated per the data; pivot is centred.
   */
  mount(data: TextObject): Container {
    return mountTextContainer(data, { wireCatchup: true })
  },

  /**
   * Thumbnail variant — skips the main-scene RenderScheduler catchup.
   * The thumbnail pipeline parents the node under an offscreen Pixi
   * Application, awaits HTMLText's `texturePromise`, and renders a
   * second frame on its own renderer. Calling `markRenderDirty()` on
   * the main scene from inside that flow makes the main editor
   * renderer try to upload the offscreen texture (foreign GL context)
   * → `texSubImage2D: bad image data` and intermittent black glyphs.
   */
  thumbnailMount(data: TextObject): Container {
    return mountTextContainer(data, { wireCatchup: false })
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
    const prevText = textNode.text
    textNode.text = buildHtmlForNode(textNode, next)
    // A content change (e.g. a per-paragraph list toggle from the Inspector,
    // which arrives as a `{ text }` patch with the same Y.Text instance)
    // rasterises its SVG asynchronously. Without a follow-up render the new
    // texture lands after the single applyChanges frame and never paints —
    // schedule the same catch-up cascade mount uses.
    if (textNode.text !== prevText) {
      scheduleAsyncTextureCatchup(textNode as unknown as { __narrativeCatchupActive?: boolean })
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
      prev.lineSpacing !== next.lineSpacing ||
      prev.wrap !== next.wrap ||
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
      'lineSpacing' in patch ||
      'wrap' in patch ||
      'stroke' in patch ||
      'strokeAlpha' in patch ||
      'strokeWidth' in patch ||
      'textTransform' in patch ||
      'paragraphSpaceBefore' in patch ||
      'paragraphSpaceAfter' in patch

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

    // PERF-4: split the style rebuild from the text/list refresh. The
    // file header promises "text-only → set textNode.text only, NO style
    // rebuild", but the old single branch reassigned
    // `textNode.style = new HTMLTextStyle(...)` on EVERY keystroke. The
    // styleKey is unchanged so Pixi doesn't re-raster the glyph atlas,
    // but the `.style` setter still forces an extra text measure per
    // keystroke. We now rebuild the style only when a typography field
    // actually changed; a pure text/list edit just updates `.text`.
    if (needsStyleRebuild) {
      textNode.style = new HTMLTextStyle(buildStyleOpts(merged))
    }
    if (textChanged || listChanged || needsStyleRebuild) {
      // The HTML always tracks the merged data — text changes,
      // listStyle, italic / underline / weight defaults all affect
      // the emitted markup.
      const prevText = textNode.text
      textNode.text = buildHtmlForNode(textNode, merged)
      // List toggles from the Inspector arrive as a `{ text }` patch on the
      // same Y.Text instance; their re-rasterised SVG lands after the single
      // applyChanges frame, so force the async texture catch-up or the new
      // markers/numbering never paint on the live canvas.
      if (textNode.text !== prevText) {
        scheduleAsyncTextureCatchup(textNode as unknown as { __narrativeCatchupActive?: boolean })
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

    // Rebuild the clip mask whenever anything it is computed from moved:
    // the box, or any typographic field — the room it opens above and
    // below the box follows the line height and the font's metrics, so a
    // line-height change alone used to leave a mask sized for the old one.
    if (layoutAffected) {
      applyClipMask(node, merged)
    }
  },

  /**
   * Release the Text node, mask, and container. Called when the object
   * is removed from the slide.
   */
  /**
   * Re-render the HTMLText body from the stored data without rebuilding
   * the style. Called by SceneGraph.refreshSlideNumberTexts() when the
   * deck's computed slide number changes (slide reorder, skip-toggle,
   * active-slide change). For non-slide-number text nodes this is a
   * no-op since `buildHtml` produces the same string.
   *
   * Returns true when this container is a text container managed by
   * this renderer AND its stored data has the slide-number flag — used
   * by the SceneGraph walker to skip irrelevant subtrees.
   */
  refreshSlideNumberText(node: Container): boolean {
    const textNode = getTextNode(node)
    if (textNode === undefined) return false
    const stored = getStoredData(node)
    if (stored === undefined || stored.isSlideNumber !== true) return false
    textNode.text = buildHtmlForNode(textNode, stored)
    applyVerticalAlign(textNode, stored)
    return true
  },

  /**
   * The text colour and the glyph stroke resolve token colours, and both
   * live in the HTMLTextStyle only (run colours in the body are literal
   * numbers; buildHtml passes no box colour). A new style re-rasterises the
   * node; the wired onViewUpdate schedules the async-texture catch-up and
   * re-flags a raster already in flight, as for an Inspector colour change.
   * Colour moves no metrics, so neither alignment nor the mask is redone.
   */
  repaintColours(node: Container, data: TextObject): void {
    const textNode = getTextNode(node)
    if (textNode === undefined) return
    textNode.style = new HTMLTextStyle(buildStyleOpts(data))
    setStoredData(node, data)
  },

  /**
   * A face of `family` was installed or removed: metrics measured against
   * whatever stood in for it are void. SceneGraph calls this before it
   * re-applies the family to every node, so the rebuilt styles and masks
   * measure the face that is now there.
   */
  forgetFontMetrics(family: string): void {
    forgetFontMetrics(family)
    forgetMeasuredLineHeight(family)
  },

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
