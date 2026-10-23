/**
 * renderer/experimental/textEngine/spike/spikePage.ts — the E7 spike page
 * (`/text-engine-spike.html`, served by the Vite dev server only: the
 * production build's only input is `index.html`). EXPERIMENTAL; nothing a
 * user sees imports it.
 *
 * One Pixi application set up as the editor's (WebGL, antialias, mipmaps,
 * the HTMLText race patch, Inter registered by the app's own
 * `registerBundledFonts`), and four ways to draw the same TextObjects:
 *
 *   - `html`  — today: `textRenderer.mount` (HTMLText, SVG foreignObject);
 *   - `dom`   — (a2) the browser's layout read as glyph runs, Canvas2D raster in a worker;
 *   - `block` — (a1) style resolved on the main thread, layout + raster in a worker;
 *   - `sdf`   — (b) the browser's layout, SDF glyph atlases (BitmapText).
 *
 * `window.__textSpike` is driven by `e2e/text-engine-spike.spec.ts`: mount a
 * scene, change the resolution (a zoom), tear down (a slide switch), and
 * compare each engine's raster of a text with HTMLText's.
 */

import 'pixi.js/unsafe-eval'
import '../../../../index.css'
import {
  Application,
  Container,
  Graphics,
  HTMLText,
  ImageSource,
  Rectangle,
  Sprite,
  Texture,
  TextureSource,
} from 'pixi.js'
import interNormalUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import interItalicUrl from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url'
import { registerBundledFonts } from '../../../../state/bundledFonts.js'
import {
  buildHtml,
  createHtmlTextStyle,
  textRenderer,
} from '../../../objectRenderers/textRenderer.js'
import { patchHTMLTextRace } from '../../../patchHTMLTextRace.js'
import { collectHtmlTextRasters } from '../../../htmlTextRaster.js'
import type { TextObject } from '../../../types'
import { CHROMIUM_LAYOUT, WEBKIT_LAYOUT, type LayoutOptions } from '../blockLayout.js'
import { blockModelTimings, buildTextBlock } from '../blockModel.js'
import { domRunsTimings, measureRuns, type MeasureOptions } from '../domRuns.js'
import { diffImage, diffRasters, type DiffStats } from '../pixelDiff.js'
import { TextRasterPool } from '../rasterClient.js'
import { rasterSize, type TextRunLayout } from '../runs.js'
import { SdfTextCache } from '../sdfText.js'
import { plainText, sceneFor, type SceneName } from './scenes.js'

TextureSource.defaultOptions.autoGenerateMipmaps = true

export type Engine = 'html' | 'dom' | 'block' | 'sdf'

/** Frame and main-thread figures of one operation. */
export interface OpStats {
  engine: Engine
  texts: number
  /** Start of the operation to the frame that shows every text. */
  readyMs: number
  /** Main-thread time inside the engine's synchronous code (layout, model, uploads). */
  syncMs: number
  /** Worker time (layout + paint), summed over texts. */
  workerMs: number
  /** Sum over frames of (interval − 16.7 ms): time the page could not draw. */
  blockedMs: number
  maxFrameMs: number
  frames: number
  /** Long tasks (Chromium only; -1 where the API is missing). */
  longTasks: number
  longTaskMs: number
  /** Time inside `app.render()` (texture uploads land here), summed / the longest. */
  renderMs: number
  maxRenderMs: number
  /** Texture pixels of the texts' rasters (thousands); SDF: atlas pixels. */
  textureKpx: number
  /** Detail of the sync time, ms. */
  detail: Record<string, number>
}

interface Mounted {
  engine: Engine
  resolution: number
  root: Container
  /** Per text: what a repaint / teardown needs. */
  items: Array<{
    key: string
    sprite?: Sprite
    textNode?: HTMLText
    layout?: TextRunLayout
  }>
}

const app = new Application()
let pool: TextRasterPool
let sdf: SdfTextCache
let mounted: Mounted | null = null
let keySeq = 0

const FRAME = 1000 / 60

/** A render loop that records frame intervals (and long tasks) until stopped. */
class FrameMonitor {
  private last = 0
  private running = false
  private intervals: number[] = []
  private longTasks: PerformanceEntry[] = []
  private observer: PerformanceObserver | null = null
  private raf = 0
  private renderMs = 0
  private maxRenderMs = 0

  start(): void {
    this.running = true
    this.renderMs = 0
    this.maxRenderMs = 0
    this.intervals = []
    this.longTasks = []
    this.last = performance.now()
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask') === true) {
      this.observer = new PerformanceObserver((list) => this.longTasks.push(...list.getEntries()))
      this.observer.observe({ type: 'longtask' })
    }
    // performance.now(), not the rAF timestamp: a frame's timestamp is its
    // vsync time, which a long task before it does not move.
    const tick = (): void => {
      if (!this.running) return
      const now = performance.now()
      this.intervals.push(now - this.last)
      this.last = now
      const r0 = performance.now()
      app.render()
      const dr = performance.now() - r0
      this.renderMs += dr
      this.maxRenderMs = Math.max(this.maxRenderMs, dr)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): Pick<
    OpStats,
    'blockedMs' | 'maxFrameMs' | 'frames' | 'longTasks' | 'longTaskMs' | 'renderMs' | 'maxRenderMs'
  > {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.observer?.disconnect()
    const supported = this.observer !== null
    this.observer = null
    return {
      blockedMs: this.intervals.reduce((s, d) => s + Math.max(0, d - FRAME), 0),
      maxFrameMs: Math.max(0, ...this.intervals),
      frames: this.intervals.length,
      longTasks: supported ? this.longTasks.length : -1,
      longTaskMs: supported ? this.longTasks.reduce((s, e) => s + e.duration, 0) : -1,
      renderMs: this.renderMs,
      maxRenderMs: this.maxRenderMs,
    }
  }
}

const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r))

async function framesAfter(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame()
}

/**
 * `?upload=canvas`: copy the bitmap into a canvas and upload that (WebKit's
 * `texImage2D` of an ImageBitmap measured ~13 µs per kpx on the main thread).
 */
const UPLOAD_VIA_CANVAS = new URLSearchParams(location.search).get('upload') === 'canvas'

function textureFromBitmap(bitmap: ImageBitmap, resolution: number): Texture {
  if (UPLOAD_VIA_CANVAS) {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    return new Texture({ source: new ImageSource({ resource: canvas, resolution }) })
  }
  return new Texture({ source: new ImageSource({ resource: bitmap, resolution }) })
}

/** All HTMLText rasters under `root` landed at their current key. */
async function htmlSettled(root: Container): Promise<void> {
  for (let guard = 0; guard < 600; guard++) {
    await nextFrame()
    // A raster starts when its text is drawn (the monitor's loop draws too; once more is harmless).
    app.render()
    const pending = collectHtmlTextRasters(root, app.renderer.uid)
    if (pending.length > 0) await Promise.all(pending)
    let busy = false
    const walk = (c: Container): void => {
      if (c instanceof HTMLText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
        const g = (c as any)._gpuData?.[app.renderer.uid]
        if (g === undefined || g.generatingTexture === true || g.currentKey !== c.styleKey)
          busy = true
      }
      for (const child of c.children) walk(child as Container)
    }
    walk(root)
    if (!busy) return
  }
  throw new Error('HTMLText rasters did not settle')
}

function htmlTextOf(c: Container): HTMLText | undefined {
  for (const child of c.children) if (child instanceof HTMLText) return child
  return undefined
}

function htmlTextureOf(t: HTMLText): Texture | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
  return (t as any)._gpuData?.[app.renderer.uid]?.texture as Texture | undefined
}

function kpxOf(t: Texture | undefined): number {
  if (t === undefined) return 0
  return (t.source.pixelWidth * t.source.pixelHeight) / 1000
}

function styleOf(data: TextObject): { markup: string; cssStyle: string; padding: number } {
  const style = createHtmlTextStyle(data)
  return { markup: buildHtml(data), cssStyle: style.cssStyle, padding: style.padding }
}

const CHROMIUM = navigator.userAgent.includes('Chrome')

/** Word positions only where the DOM kerns across spaces and the canvas does not (Chromium). */
function measureOptions(): MeasureOptions {
  return { words: CHROMIUM }
}

function layoutOptions(): LayoutOptions {
  return CHROMIUM ? CHROMIUM_LAYOUT : WEBKIT_LAYOUT
}

async function mount(engine: Engine, scene: SceneName, resolution: number): Promise<OpStats> {
  if (mounted !== null) await clear()
  app.renderer.resolution = resolution
  const objects = sceneFor(scene)
  const root = new Container()
  app.stage.addChild(root)
  const m: Mounted = { engine, resolution, root, items: [] }
  mounted = m
  const detail: Record<string, number> = {}
  const add = (k: string, v: number): void => {
    detail[k] = (detail[k] ?? 0) + v
  }
  const monitor = new FrameMonitor()
  const t0 = performance.now()
  monitor.start()
  let syncMs = 0
  let workerMs = 0
  let textureKpx = 0
  if (engine === 'html') {
    const s0 = performance.now()
    for (const data of objects) {
      const c = textRenderer.mount(data)
      root.addChild(c)
      m.items.push({ key: data.id, textNode: htmlTextOf(c)! })
    }
    syncMs += performance.now() - s0
    add('mount', syncMs)
    await htmlSettled(root)
    // The frames that upload the last textures, as for the other engines.
    await framesAfter(2)
    for (const it of m.items) textureKpx += kpxOf(htmlTextureOf(it.textNode!))
  } else if (engine === 'dom' || engine === 'block') {
    const opts = layoutOptions()
    const work: Promise<void>[] = []
    for (const data of objects) {
      const key = `${data.id}#${++keySeq}`
      const s0 = performance.now()
      const src = styleOf(data)
      add('style', performance.now() - s0)
      const holder = new Container()
      holder.x = data.x - src.padding
      holder.y = data.y - src.padding
      root.addChild(holder)
      const item: Mounted['items'][number] = { key }
      m.items.push(item)
      let job
      if (engine === 'dom') {
        const s1 = performance.now()
        const layout = measureRuns(src.markup, src, measureOptions())
        add('domLayout', domRunsTimings.layoutMs)
        add('domExtract', domRunsTimings.extractMs)
        item.layout = layout
        syncMs += performance.now() - s0
        job = pool.paint(key, layout, resolution)
        void s1
      } else {
        const block = buildTextBlock(src.markup, src)
        add('blockModel', blockModelTimings.styleMs)
        syncMs += performance.now() - s0
        job = pool.layoutPaint(key, block, resolution, opts)
      }
      work.push(
        job.then((r) => {
          const s2 = performance.now()
          const sprite = new Sprite(textureFromBitmap(r.bitmap, resolution))
          holder.addChild(sprite)
          item.sprite = sprite
          if (r.layout !== undefined) item.layout = r.layout
          const dt = performance.now() - s2
          syncMs += dt
          add('texture', dt)
          workerMs += r.layoutMs + r.paintMs
          add('workerLayout', r.layoutMs)
          add('workerPaint', r.paintMs)
          textureKpx += (r.bitmap.width * r.bitmap.height) / 1000
        }),
      )
    }
    await Promise.all(work)
    await framesAfter(2)
  } else {
    const layouts: TextRunLayout[] = []
    const s0 = performance.now()
    for (const data of objects) {
      const src = styleOf(data)
      const layout = measureRuns(src.markup, src, measureOptions())
      add('domLayout', domRunsTimings.layoutMs)
      add('domExtract', domRunsTimings.extractMs)
      layouts.push(layout)
    }
    syncMs += performance.now() - s0
    const stats = await sdf.prepare(layouts)
    workerMs += stats.glyphMs
    add('sdfPack', stats.packMs)
    add('sdfGlyphs', stats.glyphs)
    syncMs += stats.packMs
    const s1 = performance.now()
    objects.forEach((data, i) => {
      const c = sdf.build(layouts[i]!)
      c.x = data.x - layouts[i]!.padding
      c.y = data.y - layouts[i]!.padding
      root.addChild(c)
      m.items.push({ key: data.id, layout: layouts[i]! })
    })
    const dt = performance.now() - s1
    add('sdfBuild', dt)
    syncMs += dt
    textureKpx = sdf.atlasKpx
    await framesAfter(2)
  }
  const readyMs = performance.now() - t0
  return {
    engine,
    texts: objects.length,
    readyMs,
    syncMs,
    workerMs,
    ...monitor.stop(),
    textureKpx,
    detail,
  }
}

/** A zoom: every text at `resolution` (HTMLText re-rasterises; the canvas engines repaint kept layouts). */
async function zoom(resolution: number): Promise<OpStats> {
  const m = mounted
  if (m === null) throw new Error('nothing mounted')
  const monitor = new FrameMonitor()
  const detail: Record<string, number> = {}
  const t0 = performance.now()
  monitor.start()
  let syncMs = 0
  let workerMs = 0
  let textureKpx = 0
  app.renderer.resolution = resolution
  if (m.engine === 'html') {
    const s0 = performance.now()
    for (const it of m.items) it.textNode!.resolution = resolution
    syncMs = performance.now() - s0
    await htmlSettled(m.root)
    await framesAfter(2)
    for (const it of m.items) textureKpx += kpxOf(htmlTextureOf(it.textNode!))
  } else if (m.engine === 'dom' || m.engine === 'block') {
    await Promise.all(
      m.items.map(async (it) => {
        const r = await pool.repaint(it.key, resolution)
        const s = performance.now()
        const old = it.sprite?.texture
        if (it.sprite !== undefined) it.sprite.texture = textureFromBitmap(r.bitmap, resolution)
        old?.destroy(true)
        syncMs += performance.now() - s
        workerMs += r.paintMs
        textureKpx += (r.bitmap.width * r.bitmap.height) / 1000
      }),
    )
    await framesAfter(2)
  } else {
    await framesAfter(2)
    textureKpx = sdf.atlasKpx
  }
  m.resolution = resolution
  const readyMs = performance.now() - t0
  return {
    engine: m.engine,
    texts: m.items.length,
    readyMs,
    syncMs,
    workerMs,
    ...monitor.stop(),
    textureKpx,
    detail,
  }
}

/** Tear the scene down (a slide switch's first half). */
async function clear(): Promise<void> {
  const m = mounted
  mounted = null
  if (m === null) return
  if (m.engine === 'html') {
    for (const c of [...m.root.children]) textRenderer.destroy(c as Container)
  }
  m.root.destroy({ children: true, texture: m.engine === 'dom' || m.engine === 'block' })
  await pool.forgetAll()
  app.render()
}

// ---------------------------------------------------------------- fidelity

interface FidelityRow extends DiffStats {
  id: string
  /** a1 vs the browser's layout: line count / height equal, worst line top and run x deltas. */
  layout?: {
    lines: [number, number]
    height: [number, number]
    maxLineTop: number
    maxRunX: number
    runTextsEqual: boolean
  }
}

function extract(
  content: Container,
  cssW: number,
  cssH: number,
  resolution: number,
): Uint8ClampedArray {
  const wrap = new Container()
  wrap.addChild(new Graphics().rect(0, 0, cssW, cssH).fill(0xffffff))
  wrap.addChild(content)
  const out = app.renderer.extract.pixels({
    target: wrap,
    frame: new Rectangle(0, 0, cssW, cssH),
    resolution,
  })
  wrap.removeChild(content)
  wrap.destroy({ children: true })
  return new Uint8ClampedArray(out.pixels)
}

async function pngUrl(rgba: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.readAsDataURL(blob)
  })
}

function compareLayouts(a: TextRunLayout, b: TextRunLayout): NonNullable<FidelityRow['layout']> {
  let maxLineTop = 0
  for (let i = 0; i < Math.min(a.lines.length, b.lines.length); i++) {
    maxLineTop = Math.max(maxLineTop, Math.abs(a.lines[i]!.top - b.lines[i]!.top))
  }
  const ta = a.runs.map((r) => r.text.replace(/\s+$/u, '')).join('|')
  const tb = b.runs.map((r) => r.text.replace(/\s+$/u, '')).join('|')
  let maxRunX = 0
  if (a.runs.length === b.runs.length) {
    for (let i = 0; i < a.runs.length; i++) {
      maxRunX = Math.max(
        maxRunX,
        Math.abs(a.runs[i]!.x - b.runs[i]!.x),
        Math.abs(a.runs[i]!.y - b.runs[i]!.y),
      )
    }
  } else {
    maxRunX = Number.POSITIVE_INFINITY
  }
  return {
    lines: [a.lines.length, b.lines.length],
    height: [a.height, b.height],
    maxLineTop,
    maxRunX,
    runTextsEqual: ta === tb,
  }
}

/** Each text of `scene` drawn by HTMLText and by `engine` at `resolution`, compared. */
async function fidelity(
  engine: Exclude<Engine, 'html'>,
  scene: SceneName,
  resolution: number,
  images: string[] = [],
): Promise<{ rows: FidelityRow[]; images: Record<string, string[]> }> {
  if (mounted !== null) await clear()
  app.renderer.resolution = resolution
  const objects = sceneFor(scene)
  const root = new Container()
  app.stage.addChild(root)
  const htmlNodes = objects.map((d) => {
    const c = textRenderer.mount(d)
    root.addChild(c)
    return c
  })
  await htmlSettled(root)
  const rows: FidelityRow[] = []
  const pics: Record<string, string[]> = {}
  for (let i = 0; i < objects.length; i++) {
    const data = objects[i]!
    const node = htmlTextOf(htmlNodes[i]!)!
    const texture = htmlTextureOf(node)!
    const style = node.style
    const src = { cssStyle: style.cssStyle, padding: style.padding }
    const dom = measureRuns(node.text, src, measureOptions())
    let layout = dom
    let content: Container
    let row: Partial<FidelityRow> = {}
    if (engine === 'sdf') {
      await sdf.prepare([dom])
      content = sdf.build(dom)
    } else if (engine === 'dom') {
      const r = await pool.paint(`fid-${data.id}`, dom, resolution)
      content = new Sprite(textureFromBitmap(r.bitmap, resolution))
    } else {
      const block = buildTextBlock(node.text, src)
      const r = await pool.layoutPaint(`fid-${data.id}`, block, resolution, layoutOptions())
      layout = r.layout!
      row = { layout: compareLayouts(dom, layout) }
      content = new Sprite(textureFromBitmap(r.bitmap, resolution))
    }
    const size = rasterSize(dom, resolution)
    const cssW = size.width / resolution
    const cssH = size.height / resolution
    const htmlSprite = new Sprite(texture)
    const a = extract(htmlSprite, cssW, cssH, resolution)
    const b = extract(content, cssW, cssH, resolution)
    htmlSprite.destroy()
    content.destroy({ children: true, texture: engine !== 'sdf' })
    const w = Math.round(cssW * resolution)
    const h = Math.round(cssH * resolution)
    rows.push({ id: data.id, ...diffRasters(a, b, w, h), ...row })
    if (images.includes(data.id)) {
      pics[data.id] = await Promise.all([
        pngUrl(a, w, h),
        pngUrl(b, w, h),
        pngUrl(diffImage(a, b, w, h), w, h),
      ])
    }
    void layout
  }
  for (const c of [...root.children]) textRenderer.destroy(c as Container)
  root.destroy({ children: true })
  await pool.forgetAll()
  return { rows, images: pics }
}

// ---------------------------------------------------------------- boot

async function fontBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return await res.arrayBuffer()
}

async function boot(workers: number): Promise<{ workers: number; userAgent: string; dpr: number }> {
  await app.init({
    width: 1920,
    height: 1200,
    resolution: 1,
    autoDensity: true,
    backgroundAlpha: 0,
    autoStart: false,
    preference: 'webgl',
    antialias: true,
  })
  document.getElementById('stage')!.appendChild(app.canvas)
  patchHTMLTextRace(app.renderer, { wakeRenderScheduler: false, counters: 'text' })
  // The app's own registration: document.fonts and the HTMLText faces from one download.
  await registerBundledFonts()
  pool = new TextRasterPool(workers)
  sdf = new SdfTextCache(pool)
  // The workers get the same bytes and descriptors (the browser caches the download).
  const [normal, italic] = await Promise.all([fontBytes(interNormalUrl), fontBytes(interItalicUrl)])
  await pool.registerFont('Inter', normal, { weight: '100 900', style: 'normal' })
  await pool.registerFont('Inter', italic, { weight: '100 900', style: 'italic' })
  await document.fonts.ready
  app.render()
  return { workers: pool.size, userAgent: navigator.userAgent, dpr: devicePixelRatio }
}

const params = new URLSearchParams(location.search)
const workerCount = Number(params.get('workers') ?? '2')

// ---------------------------------------------------------------- decorations

/** One underline probe: a font at a size, drawn by HTMLText at a resolution. */
export interface DecorationCase {
  family: string
  weight?: number
  italic?: boolean
  size: number
  resolution: number
  /** The text under the underline; default 24 no-break spaces (no glyph ink). */
  text?: string
}

export interface DecorationRow {
  case: DecorationCase
  /** Run baseline as laid out (CSS px from the raster top, unsnapped). */
  baseline: number
  /** Device rows with ink, each with its mean ink (0–255) over the probed columns. */
  rows: Array<{ y: number; ink: number }>
  /** First and last device column with ink in the band's strongest row. */
  x0: number
  x1: number
  /** Ink per device column in the band's strongest row (skip-ink gaps). */
  columns?: number[]
  layoutWidth: number
}

/** How HTMLText draws an underline: the band's device rows and its extent. */
async function decorationProbe(cases: DecorationCase[]): Promise<DecorationRow[]> {
  if (mounted !== null) await clear()
  const out: DecorationRow[] = []
  for (const c of cases) {
    app.renderer.resolution = c.resolution
    const root = new Container()
    app.stage.addChild(root)
    const nbsp = String.fromCharCode(0xa0)
    const data = {
      id: 'probe',
      type: 'text',
      x: 0,
      y: 0,
      width: 3000,
      height: Math.ceil(c.size * 3),
      rotation: 0,
      opacity: 1,
      text: plainText([c.text ?? nbsp.repeat(24)]),
      fontSize: c.size,
      fontWeight: c.weight ?? 400,
      fontFamily: c.family,
      italic: c.italic === true,
      underline: true,
      color: 0x000000,
      align: 'left',
      wrap: 'none',
    } as unknown as TextObject
    const holder = textRenderer.mount(data)
    root.addChild(holder)
    await htmlSettled(root)
    const node = htmlTextOf(holder)!
    const texture = htmlTextureOf(node)!
    const style = node.style
    const layout = measureRuns(
      node.text,
      { cssStyle: style.cssStyle, padding: style.padding },
      {
        words: false,
      },
    )
    const w = texture.frame.width
    const h = texture.frame.height
    const sprite = new Sprite(texture)
    const px = extract(sprite, w, h, c.resolution)
    sprite.destroy()
    const W = Math.round(w * c.resolution)
    const H = Math.round(h * c.resolution)
    const ink = (x: number, y: number): number => {
      const o = (y * W + x) * 4
      return 255 - Math.min(px[o]!, px[o + 1]!, px[o + 2]!)
    }
    const rows: Array<{ y: number; ink: number }> = []
    const from = Math.round((style.padding + 2) * c.resolution)
    const to = Math.max(from + 1, W - Math.round((style.padding + 2) * c.resolution))
    let best = -1
    let bestInk = 0
    for (let y = 0; y < H; y++) {
      let sum = 0
      for (let x = from; x < to; x++) sum += ink(x, y)
      const mean = sum / (to - from)
      if (mean > 0.5) rows.push({ y, ink: Math.round(mean * 10) / 10 })
      if (mean > bestInk) {
        bestInk = mean
        best = y
      }
    }
    let x0 = -1
    let x1 = -1
    const columns: number[] = []
    if (best >= 0) {
      for (let x = 0; x < W; x++) {
        const v = ink(x, best)
        columns.push(v)
        if (v > 0) {
          if (x0 < 0) x0 = x
          x1 = x
        }
      }
    }
    const run = layout.runs[0]
    out.push({
      case: c,
      baseline: run?.y ?? Number.NaN,
      rows,
      x0,
      x1,
      ...(c.text !== undefined ? { columns } : {}),
      layoutWidth: layout.width,
    })
    textRenderer.destroy(holder)
    root.destroy({ children: true })
  }
  return out
}

/**
 * Where a centred line's text starts, read three ways — a Range over the text
 * node, the client rects of a span wrapped around it, and the span's
 * bounding box — to see which the engine snaps (WebKit snaps range rects to
 * device pixels).
 */
function rectProbe(widths: number[], size = 24): Array<Record<string, number>> {
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;contain:strict;width:4000px;height:400px;visibility:hidden'
  document.body.appendChild(host)
  const out: Array<Record<string, number>> = []
  for (const w of widths) {
    host.innerHTML = ''
    const div = document.createElement('div')
    div.style.cssText = `width:${w}px;text-align:center;font:400 ${size}px Arial;line-height:normal`
    const span = document.createElement('span')
    span.textContent = 'Centred AV text'
    div.appendChild(span)
    host.appendChild(div)
    const r = document.createRange()
    r.selectNodeContents(span.firstChild!)
    const range = r.getClientRects()[0]!
    const spanRect = span.getClientRects()[0]!
    const box = span.getBoundingClientRect()
    const c = document.createElement('canvas').getContext('2d')!
    c.font = `400 ${size}px Arial`
    const measured = c.measureText('Centred AV text').width
    out.push({
      width: w,
      rangeLeft: range.left,
      spanLeft: spanRect.left,
      boxLeft: box.left,
      rangeWidth: range.width,
      spanWidth: spanRect.width,
      measured,
      expectedLeft: (w - measured) / 2,
    })
  }
  host.remove()
  return out
}

const api = {
  ready: boot(Number.isFinite(workerCount) && workerCount > 0 ? workerCount : 2),
  mount,
  zoom,
  clear,
  fidelity,
  decorationProbe,
  rectProbe,
  /** The browser-measured layout of one text of a scene (debugging). */
  layoutOf(scene: SceneName, id: string): TextRunLayout | undefined {
    const data = sceneFor(scene).find((o) => o.id === id)
    if (data === undefined) return undefined
    const src = styleOf(data)
    return measureRuns(src.markup, src, measureOptions())
  },
  /** Heap in MB where the engine reports it (Chromium). */
  heapMb(): number {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    return mem === undefined ? -1 : mem.usedJSHeapSize / 1e6
  },
}

;(window as unknown as { __textSpike: typeof api }).__textSpike = api
