/**
 * renderer/runText/fontBox.ts — a font's content-area box as the browser's
 * inline layout uses it (ADR 0018): the ascent from the top of the content
 * area to the baseline, and the descent below it.
 *
 * Read from the DOM, once per font and face generation: Canvas2D's
 * `fontBoundingBoxAscent` is the unrounded metric, while Chromium and WebKit
 * lay lines out with rounded ones, and the half pixel between them moves a
 * baseline. An empty inline-block's bottom edge sits on its line's baseline;
 * the text range beside it is the content area.
 */

import { layoutHostRoot } from './layoutHost.js'

export interface FontBox {
  ascent: number
  descent: number
  /**
   * Where WebKit paints the baseline below the content area's top: the
   * font's unrounded ascent (TextBoxPainter::textOriginFromPaintRect adds
   * `metricsOfPrimaryFont().ascent()`), which the layout's baseline (`ascent`,
   * where an inline-block sits) misses by up to ≈0.015 px — enough to put a
   * baseline the page draws at 148.5003 at 148.4925, a device row off. Read as
   * the content height × the canvas's em-height share of it (`emHeightAscent`
   * is size × ascent / (ascent + descent), WebKit's CanvasRenderingContext2D).
   * `ascent` where the canvas does not say.
   */
  paintAscent: number
}

let emCtx: OffscreenCanvasRenderingContext2D | null | undefined

/** The font's ascent as a share of its content height, from the canvas (null: not known). */
function ascentShare(font: string): number | null {
  if (emCtx === undefined)
    emCtx =
      typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1).getContext('2d') : null
  if (emCtx === null) return null
  emCtx.font = font
  emCtx.textBaseline = 'alphabetic'
  const m = emCtx.measureText('x')
  const a = m.emHeightAscent
  const d = m.emHeightDescent
  if (!(typeof a === 'number' && typeof d === 'number') || !(a + d > 0)) return null
  return a / (a + d)
}

/** How much larger the font is laid out to read its content height finer. */
const MAGNIFY = 16

/** A text's content height in `font` (its range rect, laid out in the probe). */
function contentHeight(font: string, stretch: string, probe: HTMLElement): number {
  const span = document.createElement('span')
  span.style.font = font
  span.style.fontStretch = stretch
  span.textContent = 'x'
  probe.appendChild(span)
  const r = document.createRange()
  r.selectNodeContents(span.firstChild!)
  const h = r.getBoundingClientRect().height
  span.remove()
  return h
}

/**
 * The font's unrounded ascent (FontBox.paintAscent): its share of the
 * content height (the canvas's em-height ascent) times that height. The
 * height is read 16× larger where the font's metrics scale with its size —
 * a range rect holds it to ≈1/512 px, and a baseline 0.0006 px from a
 * rounding (Var spaced, DPR 2) needs it finer; a face whose ascent is
 * adjusted per size (WebKit's Times, Helvetica, Courier) is read as is.
 */
function paintAscentOf(
  font: string,
  stretch: string,
  height: number,
  probe: HTMLElement,
): number | null {
  const share = ascentShare(font)
  if (share === null) return null
  const m = /(\d+(?:\.\d+)?)px/u.exec(font)
  if (m !== null) {
    const size = Number(m[1])
    const big = font.replace(m[0], `${size * MAGNIFY}px`)
    const bigShare = ascentShare(big)
    if (bigShare !== null && Math.abs(bigShare - share) < 1e-6)
      return (share * contentHeight(big, stretch, probe)) / MAGNIFY
  }
  return share * height
}

const cache = new Map<string, FontBox>()
let cacheGeneration = -1

/** The content box of `font` (a CSS `font` shorthand) at `stretch` (a CSS `font-stretch`). */
export function fontBox(font: string, stretch: string, generation: number): FontBox {
  if (generation !== cacheGeneration) {
    cache.clear()
    cacheGeneration = generation
  }
  const key = `${font}|${stretch}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const probe = layoutHostRoot().probe
  const span = document.createElement('span')
  span.style.font = font
  span.style.fontStretch = stretch
  span.textContent = 'x'
  const mark = document.createElement('span')
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
  span.appendChild(mark)
  probe.appendChild(span)
  const r = document.createRange()
  r.selectNodeContents(span.firstChild!)
  const content = r.getBoundingClientRect()
  const baseline = mark.getBoundingClientRect().top
  span.remove()
  const box = {
    ascent: baseline - content.top,
    descent: content.bottom - baseline,
    paintAscent:
      paintAscentOf(font, stretch, content.bottom - content.top, probe) ?? baseline - content.top,
  }
  cache.set(key, box)
  return box
}
