/**
 * renderer/experimental/textEngine/domRuns.ts — candidate (a2) of the E7
 * spike: the browser lays the text out, exactly as HTMLText's own
 * measurement does, and the glyph runs are read off that layout; a Canvas2D
 * raster (`paint.ts`, in a worker) draws them. EXPERIMENTAL — the spike page
 * is the only importer.
 *
 * The DOM is the structure `measureHtmlText` builds (pixi.js
 * `scene/text-html`): `svg > foreignObject > div` holding the style's CSS
 * (scoped by `pixiHtmlTextStyleScope.ts`) and `<div style='padding:0'>`
 * with the markup. So the line boxes, breaks, list gutters and alignment are
 * the ones the SVG raster shows, by construction — what is new is only how
 * the glyphs are painted.
 *
 * Unlike Pixi's measurement it lays out in a host of its own with
 * `contain: strict` (canvas-performance.md step 4: Pixi appends to
 * `document.body`, so every measurement is a style and layout pass over the
 * whole app).
 *
 * What is read per text node: one rect per line fragment
 * (`Range.getClientRects`, split by binary search on the offsets), the
 * computed font, colour, letter spacing, transform, stroke and the
 * underline it inherits from an ancestor. The baseline of each font is
 * read from the DOM too, once per font (`fontBox.ts`).
 */

import { fontBox } from './fontBox.js'
import { transformText } from './textTransform.js'
import type { GlyphRun, TextRunLayout } from './runs.js'

/** What `measureRuns` needs of an HTMLTextStyle. */
export interface RunStyleSource {
  /** `HTMLTextStyle.cssStyle` — the scoped rules Pixi puts into its SVG. */
  cssStyle: string
  padding: number
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

interface Host {
  root: HTMLDivElement
  svg: SVGSVGElement
  domElement: HTMLDivElement
}

let host: Host | null = null

function getHost(): Host {
  if (host !== null && host.root.isConnected) return host
  const root = document.createElement('div')
  root.setAttribute('data-text-engine-host', '')
  // Off screen, and contained: a layout in here dirties nothing outside.
  root.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;contain:strict;visibility:hidden;pointer-events:none'
  const svg = document.createElementNS(SVG_NS, 'svg')
  const fo = document.createElementNS(SVG_NS, 'foreignObject')
  fo.setAttribute('width', '10000')
  fo.setAttribute('height', '10000')
  fo.style.overflow = 'hidden'
  svg.appendChild(fo)
  const domElement = document.createElementNS(XHTML_NS, 'div') as HTMLDivElement
  fo.appendChild(domElement)
  root.appendChild(svg)
  document.body.appendChild(root)
  host = { root, svg, domElement }
  return host
}

interface ResolvedStyle {
  font: string
  size: number
  stretchCss: string
  stretch: number
  color: string
  letterSpacing: number
  transform: string
  stroke?: { width: number; color: string }
  underline?: { color: string; size: number }
}

function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/** The underline an element draws under its text: its own or a propagated one. */
function underlineOf(el: Element, stop: Element): { color: string; size: number } | undefined {
  for (let e: Element | null = el; e !== null && e !== stop; e = e.parentElement) {
    const cs = getComputedStyle(e)
    if (cs.textDecorationLine.includes('underline')) {
      return { color: cs.color, size: px(cs.fontSize) }
    }
  }
  return undefined
}

function resolveStyle(el: Element, stop: Element): ResolvedStyle {
  const cs = getComputedStyle(el)
  const size = px(cs.fontSize)
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const out: ResolvedStyle = {
    font,
    size,
    stretchCss: cs.fontStretch,
    stretch: cs.fontStretch.endsWith('%') ? px(cs.fontStretch) : 100,
    color: cs.color,
    letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
    transform: cs.textTransform,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the prefixed stroke properties are not in lib.dom
  const anyCs = cs as any
  const strokeWidth = px(String(anyCs.webkitTextStrokeWidth ?? '0'))
  if (strokeWidth > 0) {
    out.stroke = { width: strokeWidth, color: String(anyCs.webkitTextStrokeColor ?? cs.color) }
  }
  const underline = underlineOf(el, stop)
  if (underline !== undefined) out.underline = underline
  return out
}

interface Fragment {
  start: number
  end: number
  rect: DOMRect
}

const range = (): Range => document.createRange()

/** Rects of a text node's line fragments, one per line (rects on one line merged). */
function lineRects(node: Text): DOMRect[] {
  const r = range()
  r.selectNodeContents(node)
  const rects = [...r.getClientRects()].filter((q) => q.height > 0)
  const out: DOMRect[] = []
  for (const q of rects) {
    const last = out[out.length - 1]
    if (last !== undefined && Math.abs(last.top - q.top) < 0.5) {
      const left = Math.min(last.left, q.left)
      const right = Math.max(last.right, q.right)
      out[out.length - 1] = new DOMRect(
        left,
        last.top,
        right - left,
        Math.max(last.height, q.height),
      )
    } else {
      out.push(q)
    }
  }
  return out
}

function charTop(node: Text, offset: number): number {
  const r = range()
  const end = Math.min(node.length, offset + 1)
  r.setStart(node, offset)
  r.setEnd(node, end)
  const rects = r.getClientRects()
  // A character at a line start may report the end of the previous line
  // first (a zero-width rect); the last rect is where it is drawn.
  const q = rects[rects.length - 1]
  return q === undefined ? Number.NEGATIVE_INFINITY : q.top
}

/** Split a text node into its line fragments (binary search per line boundary). */
function fragmentsOf(node: Text): Fragment[] {
  const rects = lineRects(node)
  if (rects.length === 0) return []
  if (rects.length === 1) return [{ start: 0, end: node.length, rect: rects[0]! }]
  const out: Fragment[] = []
  let start = 0
  for (let i = 0; i < rects.length - 1; i++) {
    const nextTop = rects[i + 1]!.top
    let lo = start + 1
    let hi = node.length
    // First offset whose glyph sits on the next line.
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (charTop(node, mid) >= nextTop - 0.5) hi = mid
      else lo = mid + 1
    }
    // Never split a surrogate pair.
    const code = node.data.charCodeAt(lo - 1)
    if (code >= 0xd800 && code <= 0xdbff && lo < node.length) lo++
    out.push({ start, end: lo, rect: rects[i]! })
    start = lo
  }
  out.push({ start, end: node.length, rect: rects[rects.length - 1]! })
  return out
}

/** The underline Chromium/WebKit would draw is read from no API; this is the spike's estimate. */
function underlineFor(
  u: { color: string; size: number },
  baseline: number,
): { offset: number; thickness: number; color: string } {
  void baseline
  const thickness = Math.max(1, u.size / 14)
  return { offset: Math.max(1, u.size * 0.11), thickness, color: u.color }
}

export interface MeasureOptions {
  /**
   * Read each word's position from the layout (one range rect per word). A
   * Chromium text node kerns across spaces (Arial's "A ", " A") while its
   * Canvas2D shapes word by word and does not — up to 1.3 px per pair at
   * 24 px; without word positions the raster drifts after such a pair.
   * WebKit's two agree, so it could skip them.
   */
  words: boolean
}

const WORD = /[^ ]+/gu

/** The words of a fragment at the positions the layout gave them (offsets from the run's x). */
function wordParts(
  node: Text,
  start: number,
  raw: string,
  transform: string,
  runLeft: number,
  before: string,
): Array<{ text: string; dx: number }> {
  const parts: Array<{ text: string; dx: number }> = []
  const r = range()
  for (const m of raw.matchAll(WORD)) {
    const at = start + m.index
    r.setStart(node, at)
    r.setEnd(node, at + m[0].length)
    const rects = r.getClientRects()
    const q = rects[0]
    if (q === undefined) continue
    const prev = m.index > 0 ? raw[m.index - 1]! : before
    parts.push({ text: transformText(m[0], transform, prev), dx: q.left - runLeft })
  }
  return parts
}

/** Timings of the last `measureRuns` call (spike instrumentation). */
export const domRunsTimings = { layoutMs: 0, extractMs: 0 }

/**
 * Lay `markup` out as HTMLText does and read its glyph runs. `markup` and
 * `style` are the HTMLText node's own `text` and `style`.
 */
export function measureRuns(
  markup: string,
  style: RunStyleSource,
  options: MeasureOptions = { words: true },
): TextRunLayout {
  const t0 = performance.now()
  const { domElement } = getHost()
  domElement.innerHTML = `<style>${style.cssStyle}</style><div style='padding:0'>${markup}</div>`
  domElement.setAttribute('style', 'transform-origin: top left; display: inline-block')
  const width = domElement.scrollWidth - style.padding * 2
  const height = domElement.scrollHeight - style.padding * 2
  const t1 = performance.now()
  const origin = domElement.getBoundingClientRect()
  const content = domElement.lastElementChild as HTMLElement
  const styles = new Map<Element, ResolvedStyle>()
  const runs: GlyphRun[] = []
  const lines: Array<{ top: number; bottom: number }> = []
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  let before = ' '
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const node = n as Text
    if (node.length === 0) continue
    const el = node.parentElement ?? content
    let rs = styles.get(el)
    if (rs === undefined) {
      rs = resolveStyle(el, domElement)
      styles.set(el, rs)
    }
    const ascent = fontBox(rs.font, rs.stretchCss).ascent
    for (const f of fragmentsOf(node)) {
      const raw = node.data.slice(f.start, f.end)
      const beforeRun = before
      const text = transformText(raw, rs.transform, before)
      before = raw.length > 0 ? raw[raw.length - 1]! : before
      const top = f.rect.top - origin.top
      const bottom = f.rect.bottom - origin.top
      // One line per vertical band: fragments of other fonts on a line overlap it.
      const mid = (top + bottom) / 2
      const line = lines.find((l) => mid >= l.top && mid <= l.bottom)
      if (line === undefined) lines.push({ top, bottom })
      if (text.trim() === '' && rs.underline === undefined) continue
      const y = top + ascent
      const run: GlyphRun = {
        text,
        x: f.rect.left - origin.left,
        y,
        font: rs.font,
        size: rs.size,
        stretch: rs.stretch,
        color: rs.color,
        letterSpacing: rs.letterSpacing,
        width: f.rect.width,
      }
      if (rs.stroke !== undefined) run.stroke = rs.stroke
      if (rs.underline !== undefined) run.underline = underlineFor(rs.underline, y)
      if (options.words && / \S/u.test(raw.trimStart())) {
        run.parts = wordParts(node, f.start, raw, rs.transform, run.x + origin.left, beforeRun)
      }
      runs.push(run)
    }
    if (el.tagName === 'BR') before = ' '
  }
  domElement.innerHTML = ''
  const t2 = performance.now()
  domRunsTimings.layoutMs = t1 - t0
  domRunsTimings.extractMs = t2 - t1
  lines.sort((a, b) => a.top - b.top)
  return { width, height, padding: style.padding, runs, lines }
}
