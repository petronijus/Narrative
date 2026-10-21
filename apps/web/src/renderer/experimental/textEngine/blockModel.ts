/**
 * renderer/experimental/textEngine/blockModel.ts — the markup HTMLText would
 * rasterise, resolved into a `TextBlock` for candidate (a1) of the E7 spike
 * (EXPERIMENTAL).
 *
 * The markup and its CSS stay the one definition of what a text looks like
 * (`buildHtml`, `buildStyleOpts`); this reads them back through
 * `getComputedStyle` in a `display: none` host — a style pass, no layout —
 * so every em, percentage and inherited value arrives as the browser
 * resolved it, and nothing of the CSS cascade is re-implemented. Only the
 * fonts' content boxes come from a (cached, once per font) DOM layout
 * (`fontBox.ts`).
 *
 * What the model understands is what our markup uses: paragraph `div`s,
 * text, `<br>`, the marker inline-block (`span[data-marker]`), inline
 * styling on `span`, `i`, `u`. Anything else is read as inline text.
 */

import { fontBox } from './fontBox.js'
import type { BlockInline, BlockParagraph, BlockStyle, TextBlock } from './textBlock.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

let hostElement: HTMLDivElement | null = null

/** `svg > foreignObject > div` in a display:none host: the scoped CSS matches as in Pixi's SVG. */
function host(): HTMLDivElement {
  if (hostElement !== null && hostElement.isConnected) return hostElement
  const root = document.createElement('div')
  root.setAttribute('data-text-engine-model', '')
  root.style.display = 'none'
  const svg = document.createElementNS(SVG_NS, 'svg')
  const fo = document.createElementNS(SVG_NS, 'foreignObject')
  svg.appendChild(fo)
  const dom = document.createElementNS(XHTML_NS, 'div') as HTMLDivElement
  fo.appendChild(dom)
  root.appendChild(svg)
  document.body.appendChild(root)
  hostElement = dom
  return dom
}

function px(value: string): number {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

function alignOf(value: string): 'left' | 'center' | 'right' {
  if (value === 'center') return 'center'
  if (value === 'right' || value === 'end') return 'right'
  return 'left'
}

/** Builds the style table, one entry per distinct resolved style. */
class StyleTable {
  readonly styles: BlockStyle[] = []
  private readonly byKey = new Map<string, number>()
  private readonly byElement = new Map<Element, number>()

  constructor(private readonly root: Element) {}

  of(el: Element): number {
    const known = this.byElement.get(el)
    if (known !== undefined) return known
    const cs = getComputedStyle(el)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const box = fontBox(font, cs.fontStretch)
    const style: BlockStyle = {
      font,
      size: px(cs.fontSize),
      stretch: cs.fontStretch.endsWith('%') ? px(cs.fontStretch) : 100,
      color: cs.color,
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing),
      transform: cs.textTransform,
      ascent: box.ascent,
      descent: box.descent,
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the prefixed stroke properties are not in lib.dom
    const anyCs = cs as any
    const strokeWidth = px(String(anyCs.webkitTextStrokeWidth ?? '0'))
    if (strokeWidth > 0) {
      style.stroke = { width: strokeWidth, color: String(anyCs.webkitTextStrokeColor ?? cs.color) }
    }
    for (let e: Element | null = el; e !== null && e !== this.root; e = e.parentElement) {
      const ecs = e === el ? cs : getComputedStyle(e)
      if (ecs.textDecorationLine.includes('underline')) {
        style.underline = { color: ecs.color, size: px(ecs.fontSize) }
        break
      }
    }
    const key = JSON.stringify(style)
    let index = this.byKey.get(key)
    if (index === undefined) {
      index = this.styles.length
      this.styles.push(style)
      this.byKey.set(key, index)
    }
    this.byElement.set(el, index)
    return index
  }
}

function collectInlines(node: Node, table: StyleTable, out: BlockInline[]): void {
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c.nodeType === Node.TEXT_NODE) {
      const text = (c as Text).data
      if (text.length > 0) out.push({ kind: 'text', text, style: table.of(c.parentElement!) })
      continue
    }
    if (!(c instanceof Element)) continue
    if (c.tagName === 'BR') {
      // An empty paragraph's `<br data-empty>` is its only line, not a break after one.
      if (!c.hasAttribute('data-empty')) out.push({ kind: 'br' })
      continue
    }
    if (c.hasAttribute('data-marker')) {
      out.push({
        kind: 'box',
        width: px(getComputedStyle(c).width),
        text: c.textContent ?? '',
        style: table.of(c),
      })
      continue
    }
    collectInlines(c, table, out)
  }
}

function paragraphOf(el: Element, table: StyleTable): BlockParagraph {
  const cs = getComputedStyle(el)
  const inlines: BlockInline[] = []
  collectInlines(el, table, inlines)
  return {
    marginTop: px(cs.marginTop),
    marginBottom: px(cs.marginBottom),
    paddingLeft: px(cs.paddingLeft),
    textIndent: px(cs.textIndent),
    lineHeight: px(cs.lineHeight),
    strut: table.of(el),
    align: alignOf(cs.textAlign),
    inlines,
  }
}

/** Paragraph `div`s at any depth of inline wrappers (a text-transform span); the rest is one anonymous paragraph. */
function collectParagraphs(container: Element, table: StyleTable, out: BlockParagraph[]): void {
  let loose: Element | null = null
  for (const child of [...container.childNodes]) {
    // The node's `<!--n:uid-->` cache key and any other non-content node.
    if (child.nodeType !== Node.TEXT_NODE && !(child instanceof Element)) continue
    if (child instanceof Element && child.tagName === 'DIV') {
      out.push(paragraphOf(child, table))
      loose = null
      continue
    }
    if (child instanceof Element && child.querySelector(':scope > div') !== null) {
      collectParagraphs(child, table, out)
      loose = null
      continue
    }
    // Inline content outside a paragraph: an anonymous block of its own.
    if (loose === null) {
      loose = container
      const p = paragraphOf(container, table)
      p.inlines = []
      out.push(p)
    }
    const p = out[out.length - 1]!
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child as Text).data
      if (text.length > 0) p.inlines.push({ kind: 'text', text, style: table.of(container) })
    } else if (child instanceof Element) {
      if (child.tagName === 'BR') p.inlines.push({ kind: 'br' })
      else collectInlines(child, table, p.inlines)
    }
  }
}

/** Timings of the last `buildTextBlock` call (spike instrumentation). */
export const blockModelTimings = { styleMs: 0 }

/** The TextBlock of an HTMLText node's `text` and `style`. */
export function buildTextBlock(
  markup: string,
  style: { cssStyle: string; padding: number },
): TextBlock {
  const t0 = performance.now()
  const dom = host()
  dom.innerHTML = `<style>${style.cssStyle}</style><div style='padding:0'>${markup}</div>`
  dom.setAttribute('style', 'transform-origin: top left; display: inline-block')
  const cs = getComputedStyle(dom)
  const content = dom.lastElementChild!
  const table = new StyleTable(dom)
  const paragraphs: BlockParagraph[] = []
  collectParagraphs(content, table, paragraphs)
  const wraps = cs.whiteSpace !== 'pre' && cs.whiteSpace !== 'nowrap'
  const block: TextBlock = {
    width: wraps ? px(cs.width) : null,
    padding: style.padding,
    breakWord: cs.overflowWrap === 'break-word' || cs.overflowWrap === 'anywhere',
    styles: table.styles,
    paragraphs,
  }
  dom.innerHTML = ''
  blockModelTimings.styleMs = performance.now() - t0
  return block
}
