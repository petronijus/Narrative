/**
 * renderer/runText/readRuns.ts — lay a text out in the browser and read its
 * glyph runs off the layout (ADR 0018, candidate a2 of performance.md → E7).
 *
 * The markup and CSS are the HTMLText node's own (`text`, `style.cssStyle`):
 * the look of a text stays defined by `buildHtml` / `buildStyleOpts`. They are
 * laid out in the contained host (`layoutHost.ts`) with the structure Pixi
 * rasterises with, and read back:
 *
 *   - the content size, as Pixi's `measureHtmlText` reports it
 *     (`scrollWidth` / `scrollHeight` minus the padding) — the size the
 *     vertical alignment, autofit and the clip mask use;
 *   - per text node, one rect per line fragment (`Range.getClientRects`,
 *     split by a binary search on the offsets), the computed font, colour,
 *     letter spacing, transform and stroke; each font's baseline from a probe
 *     (`fontBox.ts`);
 *   - where the canvas would not put the glyphs where the layout did, each
 *     word's own position (one range rect per word): Chromium's layout kerns
 *     across spaces while its Canvas2D shapes word by word (Arial's "A ", " A":
 *     1.3 px at 24 px), and a canvas draws a tab or a collapsed run of spaces
 *     as single spaces.
 *
 * What the painter cannot draw as the engine does is named in
 * `layout.unsupported`, and that text is rasterised by HTMLText instead
 * (runTextSystem.ts): decorations other than a solid auto underline, joined
 * script split across elements, text shadows, a
 * `font-stretch` Canvas2D cannot spell, letter spacing where the canvas has
 * none, replaced elements.
 */

import { fontBox } from './fontBox.js'
import type { Decoration, GlyphRun, TextRunLayout } from './glyphRuns.js'
import { stretchKeyword } from './glyphRuns.js'
import { layoutHostRoot } from './layoutHost.js'
import { transformText } from './textTransform.js'

/** What `readRuns` needs of an HTMLTextStyle. */
export interface RunStyleSource {
  /** `HTMLTextStyle.cssStyle` — the scoped rules Pixi puts into its SVG. */
  cssStyle: string
  padding: number
}

export interface ReadRunsOptions {
  /**
   * Read every word's position where a fragment has spaces (Chromium: its
   * layout kerns across spaces, its canvas does not). Fragments with tabs or
   * collapsed whitespace get word positions whatever this says.
   */
  wordsAtSpaces: boolean
  /** The page's face generation (fontBox's cache follows it). */
  generation: number
  /** What the page's Canvas2D can do (a run needing more is unsupported). */
  canvas: { letterSpacing: boolean; fontStretch: boolean }
  /** Whether underlines can be drawn by the engine's rules (decorations.ts). */
  decorations: boolean
}

interface ResolvedStyle {
  font: string
  stretchCss: string
  stretch: number
  color: string
  letterSpacing: number
  transform: string
  /** `white-space` collapses spaces (normal, nowrap, pre-line). */
  collapses: boolean
  stroke?: { width: number; color: string }
}

function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/** The prefixed stroke properties are not in lib.dom's CSSStyleDeclaration. */
interface StrokeStyle {
  webkitTextStrokeWidth?: string
  webkitTextStrokeColor?: string
}

function resolveStyle(el: Element): ResolvedStyle {
  const cs = getComputedStyle(el)
  const ws = cs.whiteSpace
  const out: ResolvedStyle = {
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    stretchCss: cs.fontStretch,
    stretch: fontStretchPercent(cs.fontStretch),
    color: cs.color,
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    transform: cs.textTransform,
    collapses: !(ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces'),
  }
  const stroke = cs as unknown as StrokeStyle
  const strokeWidth = px(String(stroke.webkitTextStrokeWidth ?? '0'))
  if (strokeWidth > 0) {
    out.stroke = { width: strokeWidth, color: String(stroke.webkitTextStrokeColor ?? cs.color) }
  }
  return out
}

const STRETCH_WORDS: Record<string, number> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
}

function fontStretchPercent(value: string): number {
  if (value.endsWith('%')) return px(value)
  return STRETCH_WORDS[value] ?? 100
}

/** Why an element's own style makes its text unpaintable, if it does. */
function unsupportedStyle(el: Element, rs: ResolvedStyle, opts: ReadRunsOptions): string | null {
  const cs = getComputedStyle(el)
  if (cs.textShadow !== 'none' && cs.textShadow !== '') return 'text-shadow'
  if (rs.stretch !== 100 && (!opts.canvas.fontStretch || stretchKeyword(rs.stretch) === undefined))
    return 'font-stretch'
  if (cs.writingMode !== 'horizontal-tb') return 'writing-mode'
  if (cs.direction !== 'ltr') return 'bidi'
  return null
}

/** The element whose underline a text draws, and how it looks. */
interface Decorator {
  el: Element
  font: string
  stretchCss: string
  fontSize: number
  color: string
}

/**
 * The underline a text node's element draws — its own or one it inherits
 * from an ancestor (decorations propagate to the text inside) — or null; a
 * string when it draws a decoration the painter does not reproduce (another
 * line, style, thickness or offset than the solid auto underline the markup
 * writes, or two decorations stacked).
 */
function decoratorOf(el: Element, stop: Element): Decorator | null | string {
  let found: Decorator | null = null
  for (let e: Element | null = el; e !== null; e = e.parentElement) {
    const cs = getComputedStyle(e)
    const line = cs.textDecorationLine
    if (line !== 'none' && line !== '') {
      if (found !== null) return 'decoration-nested'
      if (line !== 'underline') return `decoration-${line.replace(/\s+/gu, '-')}`
      if (cs.textDecorationStyle !== 'solid') return 'decoration-style'
      if (cs.textDecorationThickness !== 'auto') return 'decoration-thickness'
      if (cs.textUnderlineOffset !== 'auto') return 'decoration-offset'
      if (cs.textUnderlinePosition !== 'auto') return 'decoration-position'
      const skip = (cs as unknown as { textDecorationSkipInk?: string }).textDecorationSkipInk
      if (skip !== undefined && skip !== 'auto') return 'decoration-skip-ink'
      found = {
        el: e,
        font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
        stretchCss: cs.fontStretch,
        fontSize: px(cs.fontSize),
        color: cs.textDecorationColor,
      }
    }
    if (e === stop) break
  }
  return found
}

/** Strong right-to-left letters and the bidi controls: the run order is not the text order. */
const BIDI =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u200f\u202a-\u202e\u2066-\u2069\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u
/** Characters a canvas draws otherwise than the layout (a soft hyphen at a break is drawn there). */
const SOFT_HYPHEN = /\u00ad/u
/** Letters that join their neighbours (Arabic script and its presentation forms). */
const JOINING =
  /[\u0620-\u064a\u066e-\u06d3\u06d5\u06fa-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/u
/** A strong right-to-left letter. */
const STRONG_RTL =
  /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u

interface Fragment {
  start: number
  end: number
  /** The fragment's horizontal extent (all its boxes on the line). */
  rect: DOMRect
  /**
   * Top of the content area of the fragment's own font (its baseline is that
   * plus the font's ascent). A box of a fallback face on the line (an emoji)
   * has another, so it is not the extent's top.
   */
  top: number
  /** A right-to-left run (bidiRunsOf). */
  rtl?: boolean
}

/** One line of a text node: its boxes merged, and the top of the box in the node's own font. */
interface NodeLine {
  rect: DOMRect
  top: number
  center: number
}

/**
 * Whether two boxes lie on one line: their content areas overlap by at least
 * half the smaller one. Boxes of one line share a baseline, so a fallback
 * face's taller box still overlaps; consecutive lines overlap less even with
 * a line height well below the font's content height (0.75).
 */
function sameLine(a: DOMRect, b: DOMRect): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return overlap >= Math.min(a.height, b.height) / 2
}

/**
 * The lines of a text node: its boxes (`Range.getClientRects` of the whole
 * node, in logical order) grouped by line. `contentHeight` is the node's own
 * font's content height: the box closest to it gives the line's top.
 */
function nodeLines(range: Range, node: Text, contentHeight: number): NodeLine[] {
  range.selectNodeContents(node)
  const rects = [...range.getClientRects()].filter((q) => q.height > 0)
  const groups: DOMRect[][] = []
  for (const q of rects) {
    const group = groups[groups.length - 1]
    if (group !== undefined && group.some((g) => sameLine(g, q))) group.push(q)
    else groups.push([q])
  }
  return groups.map((group) => {
    const left = Math.min(...group.map((q) => q.left))
    const right = Math.max(...group.map((q) => q.right))
    const top = Math.min(...group.map((q) => q.top))
    const bottom = Math.max(...group.map((q) => q.bottom))
    let own = group[0]!
    for (const q of group) {
      if (Math.abs(q.height - contentHeight) < Math.abs(own.height - contentHeight)) own = q
    }
    return {
      rect: new DOMRect(left, top, right - left, bottom - top),
      top: own.top,
      center: (own.top + own.bottom) / 2,
    }
  })
}

/** Vertical centre of the box a character is drawn in (−∞ when it has none). */
function charCenter(range: Range, node: Text, offset: number): number {
  range.setStart(node, offset)
  range.setEnd(node, Math.min(node.length, offset + 1))
  const rects = range.getClientRects()
  // A character at a line start may report the end of the previous line
  // first (a zero-width rect); the last rect is where it is drawn.
  const q = rects[rects.length - 1]
  return q === undefined ? Number.NEGATIVE_INFINITY : (q.top + q.bottom) / 2
}

/**
 * Split a text node into its line fragments: the first character of each line
 * found by a binary search — the first offset whose box is centred below the
 * midpoint between this line's centre and the next one's.
 */
function fragmentsOf(range: Range, node: Text, contentHeight: number): Fragment[] {
  const lines = nodeLines(range, node, contentHeight)
  if (lines.length === 0) return []
  const last = lines.length - 1
  if (last === 0) return [{ start: 0, end: node.length, rect: lines[0]!.rect, top: lines[0]!.top }]
  const out: Fragment[] = []
  let start = 0
  for (let i = 0; i < last; i++) {
    const split = (lines[i]!.center + lines[i + 1]!.center) / 2
    let lo = start + 1
    let hi = node.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (charCenter(range, node, mid) > split) hi = mid
      else lo = mid + 1
    }
    // Never split a surrogate pair.
    const code = node.data.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff && lo < node.length) lo++
    out.push({ start, end: lo, rect: lines[i]!.rect, top: lines[i]!.top })
    start = lo
  }
  out.push({ start, end: node.length, rect: lines[last]!.rect, top: lines[last]!.top })
  return out
}

/**
 * A line fragment of text with right-to-left letters, split into its bidi
 * runs. The layout draws the fragment as boxes of one direction each
 * (`Range.getClientRects` returns one per box, in logical order); each
 * character belongs to the box its rect lies in, and consecutive characters of
 * one box are one run — drawn with that direction from the box's edge.
 */
function bidiRunsOf(range: Range, node: Text, f: Fragment): Fragment[] {
  range.setStart(node, f.start)
  range.setEnd(node, f.end)
  const boxes = [...range.getClientRects()].filter((q) => q.height > 0 && q.width > 0)
  if (boxes.length <= 1) {
    const text = node.data.slice(f.start, f.end)
    return [{ ...f, rtl: STRONG_RTL.test(text) && !/[A-Za-z0-9]/u.test(text) }]
  }
  /** Per character (code point): its offset, the box it lies in, its left edge. */
  const chars: Array<{ at: number; end: number; box: number; left: number }> = []
  for (let at = f.start; at < f.end;) {
    const code = node.data.charCodeAt(at)
    const end = code >= 0xd800 && code <= 0xdbff && at + 1 < f.end ? at + 2 : at + 1
    range.setStart(node, at)
    range.setEnd(node, end)
    const rects = [...range.getClientRects()].filter((q) => q.height > 0)
    const q = rects[rects.length - 1]
    if (q === undefined || q.width === 0) {
      // A mark without a box of its own: it goes with the character before it.
      const prev = chars[chars.length - 1]
      if (prev !== undefined) prev.end = end
      else chars.push({ at, end, box: 0, left: boxes[0]!.left })
    } else {
      const mid = q.left + q.width / 2
      let box = boxes.findIndex((b) => mid >= b.left - 0.01 && mid <= b.right + 0.01)
      if (box < 0) box = 0
      chars.push({ at, end, box, left: q.left })
    }
    at = end
  }
  const out: Fragment[] = []
  let i = 0
  while (i < chars.length) {
    let j = i
    while (j + 1 < chars.length && chars[j + 1]!.box === chars[i]!.box) j++
    const first = chars[i]!
    const last = chars[j]!
    const text = node.data.slice(first.at, last.end)
    const rtl = j > i ? first.left > last.left : STRONG_RTL.test(text)
    out.push({ start: first.at, end: last.end, rect: boxes[first.box]!, top: f.top, rtl })
    i = j + 1
  }
  return out
}

const WORD = /\S+/gu
const COLLAPSIBLE = /[\t\n\r\f]| {2}/u

/** The words of a fragment at the positions the layout gave them (offsets from the run's x). */
function wordParts(
  range: Range,
  node: Text,
  start: number,
  raw: string,
  transform: string,
  runLeft: number,
  before: string,
): Array<{ text: string; dx: number }> {
  const parts: Array<{ text: string; dx: number }> = []
  for (const m of raw.matchAll(WORD)) {
    const at = start + m.index
    range.setStart(node, at)
    range.setEnd(node, at + m[0].length)
    const q = range.getClientRects()[0]
    if (q === undefined) continue
    const prev = m.index > 0 ? raw[m.index - 1]! : before
    parts.push({ text: transformText(m[0], transform, prev), dx: q.left - runLeft })
  }
  return parts
}

/**
 * The string a fragment draws: collapsible whitespace collapsed as the layout
 * did — a run of spaces, tabs and newlines is one space, and a leading one is
 * dropped where the layout gave it no box (at the start of a line, or after a
 * space laid out just before it) — so its glyphs follow at the canvas's pen as
 * they did in the layout. Whether the leading space has a box is read off the
 * layout, not inferred: a fragment on the same line can start at another top
 * (another font size), and a dropped space that was there would move every
 * glyph after it.
 */
function collapse(raw: string, range: Range, node: Text, start: number): string {
  const s = raw.replace(/[\t\n\r\f ]+/gu, ' ')
  if (!s.startsWith(' ')) return s
  range.setStart(node, start)
  range.setEnd(node, start + 1)
  const boxed = [...range.getClientRects()].some((q) => q.width > 0.01 && q.height > 0)
  return boxed ? s : s.slice(1)
}

/** What Pixi writes into the container's own style attribute (`measureHtmlText`). */
const CONTAINER_INLINE = 'transform-origin: top left; display: inline-block'

/** The style's CSS when it is one rule for the container (`foreignObject > div { … }`). */
const CONTAINER_RULE = /^\s*foreignObject > div \{([^{}]*)\}\s*$/u

/**
 * The declarations of the style's CSS, when that CSS is the one rule Pixi
 * writes for the container (`textStyleToCSS`, scoped by
 * pixiHtmlTextStyleScope.ts) and nothing else — no tag rules. Laid out as the
 * container's own inline style they cascade exactly as the rule did (the
 * rule matched only the container; Pixi's inline declarations, written after
 * them, still win), and no `<style>` element enters the document: inserting
 * one makes WebKit restyle the whole page (performance.md → E7: 1.7 ms of
 * WebKit's layout per text). Null otherwise: the CSS goes in as a `<style>`.
 */
export function containerDeclarations(cssStyle: string): string | null {
  const m = CONTAINER_RULE.exec(cssStyle)
  if (m === null) return null
  const decls = m[1]!.trim().replace(/;\s*$/u, '')
  // A declaration block cannot hold markup or another rule.
  if (/[<>{}]/u.test(decls)) return null
  return decls
}

/** Timings of the last `readRuns` call, ms (the harness reads them). */
export const readRunsTimings = { layoutMs: 0, extractMs: 0 }

/**
 * Lay `markup` out as HTMLText does and read its glyph runs. `markup` and
 * `style` are the HTMLText node's own `text` and `style`.
 */
export function readRuns(
  markup: string,
  style: RunStyleSource,
  opts: ReadRunsOptions,
): TextRunLayout {
  const t0 = performance.now()
  const { domElement } = layoutHostRoot()
  const own = containerDeclarations(style.cssStyle)
  if (own !== null) {
    domElement.innerHTML = `<div style='padding:0'>${markup}</div>`
    domElement.setAttribute('style', `${own}; ${CONTAINER_INLINE}`)
  } else {
    domElement.innerHTML = `<style>${style.cssStyle}</style><div style='padding:0'>${markup}</div>`
    domElement.setAttribute('style', CONTAINER_INLINE)
  }
  const width = domElement.scrollWidth - style.padding * 2
  const height = domElement.scrollHeight - style.padding * 2
  const t1 = performance.now()
  const origin = domElement.getBoundingClientRect()
  const content = domElement.lastElementChild as HTMLElement
  const styles = new Map<Element, ResolvedStyle>()
  const decorators = new Map<Element, Decorator | null>()
  const runs: GlyphRun[] = []
  const decorations: Decoration[] = []
  let unsupported: string | undefined
  if (content.querySelector('img, svg, video, canvas, iframe, object, embed, input') !== null) {
    unsupported = 'replaced-element'
  }
  const range = document.createRange()
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  /** The last character laid out (capitalize looks back at it; so does the Arabic join check). */
  let before = ' '
  for (let n = walker.nextNode(); n !== null && unsupported === undefined; n = walker.nextNode()) {
    const node = n as Text
    if (node.length === 0) continue
    const el = node.parentElement ?? content
    let rs = styles.get(el)
    if (rs === undefined) {
      rs = resolveStyle(el)
      styles.set(el, rs)
      const why = unsupportedStyle(el, rs, opts)
      if (why !== null) {
        unsupported = why
        break
      }
    }
    const bidi = BIDI.test(node.data)
    // Chromium shapes a word across elements of the same font (Arabic
    // joining across a colour change); a canvas draws each element's text
    // alone, so such a word would lose its joins.
    if (bidi && JOINING.test(node.data[0] ?? '') && JOINING.test(before)) {
      unsupported = 'bidi-joining'
      break
    }
    if (SOFT_HYPHEN.test(node.data)) {
      unsupported = 'soft-hyphen'
      break
    }
    let decorator = decorators.get(el)
    if (decorator === undefined) {
      const d = decoratorOf(el, domElement)
      if (typeof d === 'string' || (d !== null && !opts.decorations)) {
        unsupported = typeof d === 'string' ? d : 'decoration'
        break
      }
      decorator = d
      decorators.set(el, d)
    }
    const decorBox =
      decorator === null ? null : fontBox(decorator.font, decorator.stretchCss, opts.generation)
    const box = fontBox(rs.font, rs.stretchCss, opts.generation)
    const ascent = box.ascent
    const fragments = fragmentsOf(range, node, box.ascent + box.descent)
    for (const f of bidi ? fragments.flatMap((q) => bidiRunsOf(range, node, q)) : fragments) {
      const raw = node.data.slice(f.start, f.end)
      const top = f.top - origin.top
      const beforeRun = before
      const drawn = rs.collapses ? collapse(raw, range, node, f.start) : raw
      const text = transformText(drawn, rs.transform, before)
      if (drawn.length > 0) before = drawn[drawn.length - 1]!
      const decoration: Decoration | null =
        decorator === null || decorBox === null || f.rect.width <= 0
          ? null
          : {
              x: f.rect.left - origin.left,
              width: f.rect.width,
              top,
              fontSize: decorator.fontSize,
              font: decorator.font,
              ascent: decorBox.ascent,
              descent: decorBox.descent,
              color: decorator.color,
              runs: [],
            }
      if (decoration !== null) decorations.push(decoration)
      if (text.trim() === '') continue
      decoration?.runs.push(runs.length)
      const run: GlyphRun = {
        text,
        x: f.rect.left - origin.left,
        y: top + ascent,
        font: rs.font,
        stretch: rs.stretch,
        color: rs.color,
        letterSpacing: rs.letterSpacing,
        width: f.rect.width,
      }
      if (rs.stroke !== undefined) run.stroke = rs.stroke
      if (f.rtl === true) run.rtl = true
      const spaced = / \S/u.test(raw.trimStart())
      // Word positions: Chromium's layout kerns across spaces (and its range
      // rects are exact); a preserved tab advances to a tab stop, which a
      // canvas draws as one space. Collapsed whitespace needs none where the
      // layout and the canvas agree on advances (WebKit, whose partial-range
      // rects are snapped to whole px — only whole text boxes are exact): the
      // collapsed string is drawn from the box's start.
      const tabbed = !rs.collapses && /\t/u.test(raw)
      const collapsed = rs.collapses && COLLAPSIBLE.test(raw)
      if (f.rtl !== true && (tabbed || (opts.wordsAtSpaces && (spaced || collapsed)))) {
        run.parts = wordParts(
          range,
          node,
          f.start,
          raw,
          rs.transform,
          run.x + origin.left,
          beforeRun,
        )
      }
      runs.push(run)
    }
  }
  domElement.innerHTML = ''
  const t2 = performance.now()
  readRunsTimings.layoutMs = t1 - t0
  readRunsTimings.extractMs = t2 - t1
  const layout: TextRunLayout = { width, height, padding: style.padding, runs, decorations }
  if (unsupported !== undefined) layout.unsupported = unsupported
  return layout
}
