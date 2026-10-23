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
  const box = { ascent: baseline - content.top, descent: content.bottom - baseline }
  cache.set(key, box)
  return box
}
