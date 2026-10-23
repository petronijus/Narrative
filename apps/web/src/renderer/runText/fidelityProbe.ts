/**
 * renderer/runText/fidelityProbe.ts — every text on a canvas drawn both ways,
 * compared pixel by pixel (ADR 0018's gate, in the running app).
 *
 * For each HTMLText under the renderer's last rendered stage: the texture the
 * canvas draws (from glyph runs, or HTMLText where the runs fall back) and a
 * fresh raster of the same node by Pixi's HTMLText path — the drawing before
 * ADR 0018 — are each drawn over white at the text's own resolution and read
 * back; the probe reports how they differ (`diffText`). The e2e parity specs
 * read it through `window.__narrative_runText.compare()`; nothing a user does
 * reaches it (installed only where the perf harness is: dev builds and
 * `?perf=1`, runTextSystem.ts).
 */

import { Container, Graphics, HTMLText, Rectangle, Sprite } from 'pixi.js'
import type { Renderer, Texture } from 'pixi.js'
import { mountedTextObjectId } from '../objectRenderers/textRenderer.js'
import { isRunTexture } from './runTextSystem.js'

/** How two rasters of one text differ (both RGBA over white, same size). */
export interface TextDiff {
  /** The text's markup without the node comment, shortened. */
  text: string
  /** The object id of the box or table the text belongs to, when known. */
  objectId: string | null
  width: number
  height: number
  resolution: number
  /** Drawn from glyph runs (false: the runs fell back to HTMLText). */
  runs: boolean
  /** Pixels with any channel different. */
  differing: number
  /** Pixels differing by more than 8 / 32 of 255 in some channel. */
  over8: number
  over32: number
  /** Largest channel difference. */
  maxDelta: number
  /** Pixels with ink (darker than white by > 32) in the HTMLText raster / the canvas's. */
  inkHtml: number
  inkCanvas: number
}

/** The Pixi internals the probe reads (per-renderer GPU data of a text). */
interface GpuText {
  texture?: Texture
}

function objectIdOf(node: Container): string | null {
  for (let c: Container | null = node; c !== null; c = c.parent) {
    const id = mountedTextObjectId(c)
    if (id !== undefined && id !== '') return id
  }
  return null
}

function extractOverWhite(
  renderer: Renderer,
  texture: Texture,
  w: number,
  h: number,
  resolution: number,
): Uint8ClampedArray {
  const wrap = new Container()
  wrap.addChild(new Graphics().rect(0, 0, w, h).fill(0xffffff))
  const sprite = new Sprite(texture)
  wrap.addChild(sprite)
  const out = renderer.extract.pixels({
    target: wrap,
    frame: new Rectangle(0, 0, w, h),
    resolution,
  })
  wrap.removeChild(sprite)
  sprite.destroy()
  wrap.destroy({ children: true })
  return new Uint8ClampedArray(out.pixels)
}

/** Compare two RGBA rasters of the same size. */
export function diffText(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
): Pick<TextDiff, 'differing' | 'over8' | 'over32' | 'maxDelta' | 'inkHtml' | 'inkCanvas'> {
  let differing = 0
  let over8 = 0
  let over32 = 0
  let maxDelta = 0
  let inkHtml = 0
  let inkCanvas = 0
  for (let i = 0; i < a.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c]! - b[i + c]!))
    if (d > 0) differing++
    if (d > 8) over8++
    if (d > 32) over32++
    if (d > maxDelta) maxDelta = d
    if (255 - Math.min(a[i]!, a[i + 1]!, a[i + 2]!) > 32) inkHtml++
    if (255 - Math.min(b[i]!, b[i + 1]!, b[i + 2]!) > 32) inkCanvas++
  }
  return { differing, over8, over32, maxDelta, inkHtml, inkCanvas }
}

/**
 * Compare every text under `root` (default: the renderer's last rendered
 * stage). `htmlRaster` is the system's HTMLText path (runTextSystem keeps it).
 */
export async function compareTexts(
  renderer: Renderer,
  htmlRaster: (text: HTMLText) => Promise<Texture>,
  returnHtml: (p: Promise<Texture>) => void,
  root?: Container,
): Promise<TextDiff[]> {
  const stage = root ?? (renderer.lastObjectRendered as Container | undefined)
  if (stage === undefined) return []
  const texts: HTMLText[] = []
  const walk = (c: Container): void => {
    // Hidden subtrees are not drawn: their rasters are not the canvas's.
    if (!c.visible || !c.renderable) return
    if (c instanceof HTMLText && c.text !== '') texts.push(c)
    for (const child of c.children) walk(child as Container)
  }
  walk(stage)
  const rows: TextDiff[] = []
  for (const t of texts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    const gpu = (t as any)._gpuData?.[renderer.uid] as GpuText | undefined
    const shown = gpu?.texture
    if (shown === undefined || shown.source === undefined || shown.frame.width <= 1) continue
    const resolution = shown.source.resolution
    const w = shown.frame.width
    const h = shown.frame.height
    const promise = htmlRaster(t)
    const html = await promise
    try {
      const a = extractOverWhite(renderer, html, w, h, resolution)
      const b = extractOverWhite(renderer, shown, w, h, resolution)
      const sameSize = html.frame.width === w && html.frame.height === h
      const d =
        sameSize && a.length === b.length
          ? diffText(a, b)
          : { differing: -1, over8: -1, over32: -1, maxDelta: -1, inkHtml: -1, inkCanvas: -1 }
      rows.push({
        text: t.text.replace(/^<!--n:\d+-->/u, '').slice(0, 160),
        objectId: objectIdOf(t),
        width: Math.round(w * resolution),
        height: Math.round(h * resolution),
        resolution,
        runs: isRunTexture(shown),
        ...d,
      })
    } finally {
      returnHtml(promise)
    }
  }
  return rows
}
