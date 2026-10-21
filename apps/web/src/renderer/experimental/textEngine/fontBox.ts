/**
 * renderer/experimental/textEngine/fontBox.ts — a font's content-area box as
 * the browser's inline layout uses it (E7 spike, EXPERIMENTAL): the ascent
 * from the top of the content area to the baseline, and the descent below.
 *
 * Read from the DOM, once per font: Canvas2D's `fontBoundingBoxAscent` is
 * the unrounded metric, while Chromium and WebKit lay lines out with
 * rounded ones, and the half-pixel between them moves a baseline. An empty
 * inline-block's bottom edge sits on its line's baseline; the text range
 * beside it is the content area.
 */

export interface FontBox {
  ascent: number
  descent: number
}

const cache = new Map<string, FontBox>()
let probeHost: HTMLDivElement | null = null

function host(): HTMLDivElement {
  if (probeHost !== null && probeHost.isConnected) return probeHost
  const el = document.createElement('div')
  el.setAttribute('data-text-engine-probe', '')
  el.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;contain:strict;visibility:hidden;' +
    'pointer-events:none;white-space:pre;line-height:normal'
  document.body.appendChild(el)
  probeHost = el
  return el
}

/** The content box of `font` (a CSS `font` shorthand) at `stretch` (a CSS `font-stretch`). */
export function fontBox(font: string, stretch = '100%'): FontBox {
  const key = `${font}|${stretch}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const span = document.createElement('span')
  span.style.font = font
  span.style.fontStretch = stretch
  span.textContent = 'x'
  const mark = document.createElement('span')
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
  span.appendChild(mark)
  host().appendChild(span)
  const r = document.createRange()
  r.selectNodeContents(span.firstChild!)
  const content = r.getBoundingClientRect()
  const baseline = mark.getBoundingClientRect().top
  span.remove()
  const box = { ascent: baseline - content.top, descent: content.bottom - baseline }
  cache.set(key, box)
  return box
}

/** Forget every box (a face landed). */
export function forgetFontBoxes(): void {
  cache.clear()
}
