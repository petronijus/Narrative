/**
 * renderer/htmlTextGroupRaster.ts — HTMLTexts of one group (a table's cells)
 * rasterised through one SVG, each still with a texture of its own
 * (docs/plans/performance.md → E5).
 *
 * Pixi rasterises every HTMLText through an SVG image of its own
 * (`HTMLTextSystem._buildTexturePromise`): its markup in a foreignObject,
 * the `@font-face` CSS of its families embedded as data URLs, loaded as an
 * `<img>`. A 12 × 8 table in a folder font was 96 such images and 96 copies
 * of the same ~64 kB font CSS (6 MB for one slide) for the browser to parse
 * and decode, each raster on its own.
 *
 * Here the rasters a group asks for within one task (Pixi asks while it
 * builds a frame, every changed cell in turn) wait for a microtask and are
 * drawn together: per set of embedded faces, one SVG holding every cell at
 * an integer place of its own, the faces once. Each cell then gets exactly
 * the texture Pixi would have made — the same pooled power-of-two texture,
 * frame and resolution, its pixels copied 1:1 out of the shared image (into
 * a canvas covering the whole pooled texture, as every text raster now is:
 * patchHTMLTextRace `wholeTextureCanvas`) — so nothing on screen changes:
 *
 *   - measured by Pixi's own `measureHtmlText` with the cell's own text,
 *     style and font CSS, sized by Pixi's formula (`_buildTexturePromise`:
 *     the padding on both sides, the resolution, the 2 px uv margin);
 *   - each cell's markup is Pixi's (`getSVGUrl`): `<style>` + the padded
 *     `div` in an inline-block scaled by the resolution, on a line of its
 *     own as wide as Pixi's foreignObject, clipped to its own image's size;
 *     only its selectors are scoped to its element (they are document-wide,
 *     and every cell's would style every other);
 *   - placed at whole pixels, so its glyphs are rasterised exactly as in an
 *     image of its own (a translation by whole device pixels), and copied
 *     out without resampling.
 *
 * Only cells whose faces are the same share an image (the faces a cell
 * embeds are matched to it, E2): a cell never sees a face it would not have
 * had. A change to one cell rasterises that cell alone — a group of one. An
 * image is kept under `MAX_ATLAS_PX` (a table at a high zoom takes several).
 * WebKit's 100 ms wait for embedded fonts (`loadSVGImage`) is made once per
 * image instead of once per cell.
 *
 * Anything that fails falls back to Pixi's own raster for the cells of that
 * image. WebKit does not group at all (`GROUP_RASTER_SUPPORTED`). `globalThis.__narrative_noGroupRaster = true` before the app starts
 * turns grouping off (the pixel comparison of e2e/table-raster-pixels.spec.ts
 * draws the same table both ways).
 */

import {
  BigPool,
  extractFontFamilies,
  getFontCss,
  getPo2TextureFromSource,
  HTMLTextRenderData,
  isSafari,
  loadSVGImage,
  measureHtmlText,
} from 'pixi.js'
import type { HTMLText, HTMLTextStyle, Renderer, Texture } from 'pixi.js'
import { MEASUREMENT_SCOPE } from './pixiHtmlTextStyleScope.js'

const GROUP = new WeakMap<object, object>()

/**
 * Let `text`'s rasters share an SVG with the other texts of `group` (any
 * object: the table's container), or stop it (`null`).
 */
export function setHtmlTextRasterGroup(text: HTMLText, group: object | null): void {
  if (group === null) GROUP.delete(text)
  else GROUP.set(text, group)
}

/**
 * Whether this engine draws a shared SVG's embedded faces reliably — Blink
 * yes, WebKit (Safari, WKWebView and so the Tauri shell, Playwright's
 * WebKit) no, so there every text keeps Pixi's raster of its own.
 *
 * Found by e2e/table-raster-pixels.spec.ts, 2026-10-21: in WebKit the shared
 * image of the table's 86 upright cells drew in Arial instead of the
 * embedded Inter, and from then on no SVG image in that page used the face —
 * not another shared image, not Pixi's own one-cell SVG drawn there later
 * (with or without the `@font-face`: the same pixels), while the same SVGs
 * drawn in a fresh page, and every image of a page that never grouped, used
 * it. The engine's loading of that data-URL face fails and the failure
 * sticks to the page; nothing a page can do was found to undo or avoid it
 * (waiting, `decode()`, Pixi's image attributes, loading the face in the
 * document first). Grouping gained WebKit ~10 % (performance.md → E5);
 * correct glyphs come first. Read from the user agent once: Pixi's
 * `isSafari()` misses WKWebView, whose agent does not say Safari.
 */
export function groupRasterSupported(userAgent: string): boolean {
  return !(/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(userAgent))
}

export const GROUP_RASTER_SUPPORTED: boolean =
  typeof navigator !== 'undefined' && groupRasterSupported(navigator.userAgent)

/** The group of what Pixi hands `_buildTexturePromise` (the HTMLText itself), if any. */
export function htmlTextRasterGroup(options: unknown): object | undefined {
  if (typeof options !== 'object' || options === null) return undefined
  if (!GROUP_RASTER_SUPPORTED) return undefined
  if ((globalThis as { __narrative_noGroupRaster?: boolean }).__narrative_noGroupRaster === true)
    return undefined
  return GROUP.get(options)
}

/** Pixel area one shared image may have (device px); a bigger group takes several. */
export const MAX_ATLAS_PX = 4_000_000
/** Widest shared image (device px). */
export const MAX_ATLAS_SIDE = 4096
/** Transparent room between two cells' images in the shared one (device px). */
const GUTTER = 2
/** Pixi's `uvSafeOffset`: its image is this much wider and taller than the texture's frame. */
const UV_SAFE_OFFSET = 2
/** Pixi's foreignObject is this large; a cell is laid out on a line this wide. */
const FOREIGN_OBJECT_PX = 10000

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** The texts of one raster request: what Pixi's `_buildTexturePromise` reads from its options. */
interface RasterText {
  text: string
  style: HTMLTextStyle
  resolution: number
  autoGenerateMipmaps?: boolean
  textureStyle?: { scaleMode?: unknown } | null
}

interface Request {
  text: RasterText
  group: object
  resolve: (t: Texture) => void
  reject: (e: unknown) => void
}

interface Measured {
  request: Request
  /** The size of the image Pixi would have drawn (device px, the uv margin included). */
  w: number
  h: number
  x: number
  y: number
}

export interface GroupRasterHooks {
  /** A raster of a shared image started (`text.raster.started` …); `px` its size, `fontKb` its CSS. */
  onRaster(info: { px: number; fontKb: number; safariDelay: boolean; cells: number }): void
  /** A shared image's textures are ready. */
  onReady(): void
  /** Pixi's own raster of one text — the fallback. */
  single(text: RasterText): Promise<Texture>
  /**
   * The texture of a cell whose pixels are `pixels` (`width` × `height`, the
   * uv margin included): `make` is Pixi's pooled texture for them; the hook
   * uploads it (patchHTMLTextRace: once, the whole texture covered).
   */
  texture(
    pixels: HTMLCanvasElement,
    width: number,
    height: number,
    make: (pixels: HTMLCanvasElement) => Texture,
  ): Texture
}

export interface GroupRaster {
  request(text: unknown, group: object): Promise<Texture>
}

/** Cell `index`'s CSS (Pixi's `cssStyle`, scoped to the foreignObject) scoped to its own element. */
export function scopeToCell(css: string, cls: string): string | null {
  const scope = MEASUREMENT_SCOPE
  if (!css.trimStart().startsWith(scope)) return null
  return css.replace(new RegExp(`${scope}( > div)?(?=[\\s,{])`, 'g'), `${scope} div.${cls}`)
}

/** Shelf-pack images into rows no wider than `maxW`; returns the packed size. */
export function packShelves(
  items: Array<{ w: number; h: number; x: number; y: number }>,
  maxW: number,
): { w: number; h: number } {
  let x = 0
  let y = 0
  let rowH = 0
  let width = 0
  for (const it of items) {
    if (x > 0 && x + it.w > maxW) {
      y += rowH + GUTTER
      x = 0
      rowH = 0
    }
    it.x = x
    it.y = y
    x += it.w + GUTTER
    rowH = Math.max(rowH, it.h)
    width = Math.max(width, x - GUTTER)
  }
  return { w: Math.max(1, width), h: Math.max(1, y + rowH) }
}

export function createGroupRaster(renderer: Renderer, hooks: GroupRasterHooks): GroupRaster {
  let queue: Request[] = []
  let scheduled = false

  const fallback = (list: readonly Request[]): void => {
    for (const r of list) hooks.single(r.text).then(r.resolve, r.reject)
  }

  const flush = (): void => {
    scheduled = false
    const batch = queue
    queue = []
    const byKey = new Map<object, Map<number, Request[]>>()
    for (const r of batch) {
      let res = byKey.get(r.group)
      if (res === undefined) byKey.set(r.group, (res = new Map()))
      const list = res.get(r.text.resolution)
      if (list === undefined) res.set(r.text.resolution, [r])
      else list.push(r)
    }
    for (const byRes of byKey.values())
      for (const list of byRes.values()) {
        if (list.length === 1) fallback(list)
        else void rasterGroup(list)
      }
  }

  const rasterGroup = async (list: Request[]): Promise<void> => {
    try {
      const withCss = await Promise.all(
        list.map(async (r) => {
          const families = extractFontFamilies(r.text.text, r.text.style)
          return { r, families: families.length, css: await getFontCss(families) }
        }),
      )
      const byCss = new Map<string, { css: string; families: number; list: Request[] }>()
      for (const { r, css, families } of withCss) {
        const g = byCss.get(css)
        if (g === undefined) byCss.set(css, { css, families, list: [r] })
        else g.list.push(r)
      }
      for (const g of byCss.values()) {
        if (g.list.length === 1) fallback(g.list)
        else for (const chunk of measureAndChunk(g.list, g.css)) void rasterAtlas(chunk, g)
      }
    } catch {
      fallback(list)
    }
  }

  /** Each request's image size (Pixi's measurement and formula), in chunks under the size limits. */
  const measureAndChunk = (list: readonly Request[], css: string): Measured[][] => {
    const data = BigPool.get(HTMLTextRenderData)
    const measured: Measured[] = []
    try {
      for (const request of list) {
        const { text, style, resolution } = request.text
        const m = measureHtmlText(text, style, css, data)
        const width = Math.ceil(Math.ceil(Math.max(1, m.width) + style.padding * 2) * resolution)
        const height = Math.ceil(Math.ceil(Math.max(1, m.height) + style.padding * 2) * resolution)
        measured.push({
          request,
          w: (width | 0) + UV_SAFE_OFFSET,
          h: (height | 0) + UV_SAFE_OFFSET,
          x: 0,
          y: 0,
        })
      }
    } finally {
      BigPool.return(data)
    }
    measured.sort((a, b) => b.h - a.h)
    const chunks: Measured[][] = []
    let chunk: Measured[] = []
    let area = 0
    for (const m of measured) {
      const px = (m.w + GUTTER) * (m.h + GUTTER)
      if (chunk.length > 0 && area + px > MAX_ATLAS_PX) {
        chunks.push(chunk)
        chunk = []
        area = 0
      }
      chunk.push(m)
      area += px
    }
    if (chunk.length > 0) chunks.push(chunk)
    return chunks
  }

  const rasterAtlas = async (
    items: Measured[],
    g: { css: string; families: number },
  ): Promise<void> => {
    const requests = items.map((m) => m.request)
    if (items.length === 1) return fallback(requests)
    try {
      const widest = Math.max(...items.map((m) => m.w))
      const size = packShelves(items, Math.max(widest, Math.min(MAX_ATLAS_SIDE, widestRow(items))))
      const svg = atlasSvg(items, size, g.css)
      if (svg === null) return fallback(requests)
      const image = new Image()
      const delay = isSafari() && g.families > 0
      hooks.onRaster({
        px: size.w * size.h,
        fontKb: Math.round(g.css.length / 1024),
        safariDelay: delay,
        cells: items.length,
      })
      await loadSVGImage(image, svg, delay)
      for (const m of items) {
        const { text } = m.request
        const canvas = document.createElement('canvas')
        canvas.width = m.w
        canvas.height = m.h
        const ctx = canvas.getContext('2d')
        if (ctx === null) {
          fallback([m.request])
          continue
        }
        ctx.drawImage(image, m.x, m.y, m.w, m.h, 0, 0, m.w, m.h)
        const texture = hooks.texture(canvas, m.w, m.h, (pixels) => {
          const t = getPo2TextureFromSource(
            pixels,
            m.w - UV_SAFE_OFFSET,
            m.h - UV_SAFE_OFFSET,
            text.resolution,
            text.autoGenerateMipmaps,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's SCALE_MODE, passed through as it reads it
            text.textureStyle?.scaleMode as any,
          )
          renderer.texture.initSource(t.source)
          return t
        })
        m.request.resolve(texture)
      }
      image.src = ''
      hooks.onReady()
    } catch {
      fallback(requests)
    }
  }

  return {
    request(text, group) {
      return new Promise<Texture>((resolve, reject) => {
        queue.push({ text: text as RasterText, group, resolve, reject })
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      })
    },
  }
}

/** About √(area) wide: shelves of a roughly square image. */
function widestRow(items: readonly Measured[]): number {
  let area = 0
  for (const m of items) area += (m.w + GUTTER) * (m.h + GUTTER)
  return Math.ceil(Math.sqrt(area))
}

/**
 * The shared SVG: the faces once, then each cell in a box of its image's
 * size at its packed place — inside it Pixi's own markup (`getSVGUrl`) with
 * the cell's selectors scoped to its element. Serialised as Pixi serialises
 * its own (XMLSerializer over the same namespaced nodes).
 */
function atlasSvg(items: readonly Measured[], size: { w: number; h: number }, css: string) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size.w))
  svg.setAttribute('height', String(size.h))
  const fo = document.createElementNS(SVG_NS, 'foreignObject')
  fo.setAttribute('width', String(Math.max(FOREIGN_OBJECT_PX, size.w)))
  fo.setAttribute('height', String(Math.max(FOREIGN_OBJECT_PX, size.h)))
  ;(fo as SVGElement).style.overflow = 'hidden'
  svg.appendChild(fo)
  const fonts = document.createElementNS(XHTML_NS, 'style')
  fonts.textContent = css
  fo.appendChild(fonts)
  const sheet = document.createElementNS(XHTML_NS, 'div')
  sheet.setAttribute('style', `position:relative;width:${size.w}px;height:${size.h}px`)
  fo.appendChild(sheet)
  for (const [i, m] of items.entries()) {
    const { text, style, resolution } = m.request.text
    const cls = `narrative-raster-cell-${i}`
    const scoped = scopeToCell(style.cssStyle, cls)
    if (scoped === null) return null
    const box = document.createElementNS(XHTML_NS, 'div')
    box.setAttribute(
      'style',
      `position:absolute;left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;overflow:hidden`,
    )
    const line = document.createElementNS(XHTML_NS, 'div')
    line.setAttribute('style', `width:${FOREIGN_OBJECT_PX}px`)
    const el = document.createElementNS(XHTML_NS, 'div')
    el.setAttribute('class', cls)
    el.innerHTML = `<style>${scoped}</style><div style='padding:0;'>${text}</div>`
    el.setAttribute(
      'style',
      `transform: scale(${resolution});transform-origin: top left; display: inline-block`,
    )
    line.appendChild(el)
    box.appendChild(line)
    sheet.appendChild(box)
  }
  return new XMLSerializer().serializeToString(svg)
}
