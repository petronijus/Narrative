/**
 * renderer/runText/layoutHost.ts — the contained host the canvas's text is
 * laid out in (ADR 0018).
 *
 * The structure is the one Pixi's HTMLText measures and rasterises with
 * (`HTMLTextRenderData`): `svg > foreignObject[10000 × 10000] > div`, the
 * style's CSS (scoped to `foreignObject > div` by pixiHtmlTextStyleScope.ts)
 * and `<div style='padding:0'>` with the markup inside — so line boxes,
 * breaks, list gutters and alignment are the ones the SVG raster showed, by
 * construction.
 *
 * What differs from Pixi's measurement, deliberately:
 *
 *   - **Contained.** Pixi appends its SVG to `document.body` for every
 *     measurement: a style and layout pass over the whole app
 *     (canvas-performance.md step 4). The host is `contain: strict`, fixed,
 *     0 × 0 and invisible: a layout in it dirties nothing outside.
 *   - **The SVG image's environment, not the app's.** The raster happens in
 *     an SVG image document, which inherits nothing from the app; Pixi's
 *     measurement inherited the app's body styles (Tailwind's preflight
 *     `tab-size: 4`, the body's `font-feature-settings`, its `lang`). The host
 *     resets every inherited property (`all: initial`) and states no
 *     language, so the one layout here is the raster's.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

export interface LayoutHost {
  root: HTMLDivElement
  /** The `div` Pixi's markup goes into (`HTMLTextRenderData.domElement`). */
  domElement: HTMLDivElement
  /** Where font probes are laid out (fontBox.ts), outside the foreignObject. */
  probe: HTMLDivElement
}

let host: LayoutHost | null = null

const HOST_CSS =
  'all:initial;display:block;position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;' +
  'contain:strict;visibility:hidden;pointer-events:none;z-index:-1'

/** The page's layout host (made on first use; made again if something removed it). */
export function layoutHostRoot(): LayoutHost {
  if (host !== null && host.root.isConnected) return host
  const root = document.createElement('div')
  root.setAttribute('data-narrative-text-layout', '')
  root.setAttribute('aria-hidden', 'true')
  root.setAttribute('lang', '')
  root.style.cssText = HOST_CSS
  const svg = document.createElementNS(SVG_NS, 'svg')
  const fo = document.createElementNS(SVG_NS, 'foreignObject')
  fo.setAttribute('width', '10000')
  fo.setAttribute('height', '10000')
  fo.style.overflow = 'hidden'
  svg.appendChild(fo)
  const domElement = document.createElementNS(XHTML_NS, 'div') as HTMLDivElement
  fo.appendChild(domElement)
  root.appendChild(svg)
  const probe = document.createElement('div')
  probe.style.cssText = 'white-space:pre;line-height:normal'
  root.appendChild(probe)
  document.body.appendChild(root)
  host = { root, domElement, probe }
  return host
}
