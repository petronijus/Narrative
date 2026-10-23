/**
 * renderer/patchHTMLTextRace.ts
 *
 * Workaround for a real race in pixi.js 8.x's HTMLTextSystem on the
 * WebGL backend.
 *
 * Pixi's `_buildTexturePromise` flow:
 *   1. `BigPool.get(HTMLTextRenderData)` → returns an object that owns a
 *      single `<img>` element. Pixi sets `image.src` to the SVG URL and
 *      awaits the onload.
 *   2. `getPo2TextureFromSource(image, …)` writes
 *      `texture.source.resource = image` — i.e. the texture HOLDS the
 *      pooled `<img>` directly (no copy).
 *   3. `BigPool.return(htmlTextData)` returns the htmlTextData to the
 *      pool. Crucially the `<img>` element is still alive and is still
 *      referenced by the texture from step 2.
 *
 * On WebGPU the system runs an extra `getTemporaryCanvasFromImage` step
 * that snapshots the pooled image onto a dedicated canvas, so the
 * texture's resource ends up independent of the pool. On WebGL that
 * branch is skipped and the texture is left referencing the pooled
 * `<img>`.
 *
 * The bug: when a second concurrent (or merely subsequent)
 * `_buildTexturePromise` pops the same htmlTextData from the pool and
 * sets `image.src = otherSvgURL`, every previously-built texture that
 * still references that `<img>` now points at the wrong content. As
 * soon as the renderer re-uploads any of those textures, it reads the
 * OTHER node's SVG image. In the editor this surfaces as: duplicate
 * component instances whose headline disappears, swaps with the body
 * text, or briefly shows a totally different text from the canvas —
 * texts pulled from whatever HTMLText built last.
 *
 * Fix: after the pixi pipeline finishes building a texture, snapshot
 * the pooled `<img>` onto a per-call `<canvas>` and rebind the
 * texture's source.resource to that canvas. The canvas is owned by
 * the texture (not by the pool), so the pool can recycle the `<img>`
 * freely without corrupting any live texture. We also `emit('update')`
 * so the GPU upload re-runs against the canvas. Behavior is identical
 * to WebGPU's `_createCanvas` branch.
 *
 * This is a userland mitigation; the proper fix lives upstream in
 * pixi.js. Until then, the patch makes HTMLText texture builds
 * deterministic regardless of how many nodes are dirty in one frame.
 */

import { extractFontFamilies, getFontCss, HTMLTextRenderData, isSafari } from 'pixi.js'
import type { HTMLTextStyle, Renderer, Texture } from 'pixi.js'
import { perfCount, perfCountersOn } from '@narrative/shared'
import { markRenderDirty } from './RenderScheduler.js'
import { createGroupRaster, htmlTextRasterGroup } from './htmlTextGroupRaster.js'

const PATCHED = Symbol('narrativeHtmlTextPatched')

interface HTMLTextSystemLike {
  _createCanvas?: boolean
  _buildTexturePromise(options: unknown): Promise<unknown>
  [PATCHED]?: boolean
}

interface TextureLike {
  source: {
    resource: unknown
    uploadMethodId: string
    pixelWidth: number
    pixelHeight: number
    emit: (event: string, ...args: unknown[]) => void
  }
}

/**
 * What a raster embeds (docs/plans/performance.md → E2): the kB of
 * `@font-face` CSS Pixi puts into its SVG — the same `getFontCss` call
 * `_buildTexturePromise` makes, memoised per family, so counting adds no
 * fetch — and whether the raster waits Pixi's fixed 100 ms first (WebKit,
 * `isSafari()` with any family named; W1). Only while the harness counts.
 */
async function countEmbeddedFonts(
  options: unknown,
  fontKb: string,
  safariDelay: string,
): Promise<void> {
  // The HTMLText itself, or `getTexturePromise`'s options: both carry these two.
  const o = options as { text?: unknown; style?: HTMLTextStyle }
  if (typeof o.text !== 'string' || o.style === undefined) return
  const families = extractFontFamilies(o.text, o.style)
  if (isSafari() && families.length > 0) perfCount(safariDelay)
  try {
    const css = await getFontCss(families)
    perfCount(fontKb, Math.round(css.length / 1024))
  } catch {
    /* the raster reports its own failure */
  }
}

/** The SVG URL Pixi's `loadSVGImage` gives the pooled `<img>` of an HTMLText raster. */
const PIXI_SVG_RASTER_URL = 'data:image/svg+xml;charset=utf8,'

interface TextureSourceLike {
  resource: unknown
}

/** The part of a pooled texture's source a raster fills. */
interface RasterSource {
  resource: unknown
  uploadMethodId: string
  pixelWidth: number
  pixelHeight: number
}

/**
 * The canvas a raster's texture is uploaded from: the raster's pixels at the
 * top left of a canvas as large as the whole texture, transparent beyond.
 *
 * Text textures come from Pixi's `TexturePool` (`getPo2TextureFromSource`):
 * power-of-two sizes, shared by every renderer, handed from one text to the
 * next. An upload of only the raster's own rectangle leaves the rest of a
 * reused texture as the previous text left it. The editor samples a text at
 * mip level 0 and never reaches those texels (the 2 px margin Pixi keeps
 * around the frame is the raster's own); a thumbnail, drawn ~8× smaller,
 * reads the mip levels, which average them in — faint ghosts of other texts
 * under a table's cells, different with every pool history
 * (e2e/table-raster-pixels.spec.ts found them). Covering the whole texture
 * leaves nothing stale to average.
 */
export function wholeTextureCanvas(
  pixels: CanvasImageSource,
  width: number,
  height: number,
  source: RasterSource,
): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(width, source.pixelWidth)
  canvas.height = Math.max(height, source.pixelHeight)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  ctx.drawImage(pixels, 0, 0, width, height, 0, 0, width, height)
  return canvas
}

/**
 * What a finished raster's pooled render data holds on to (performance.md
 * → E8). Pixi pools one `HTMLTextRenderData` per raster in flight (BigPool,
 * never shrunk) and each keeps its `<img>` on the last SVG it drew: a whole
 * SVG document with the text's DOM and its @font-face CSS, in Blink a page of
 * its own (frame, style engine, the parsed fonts). The pool grows with the
 * most rasters ever in flight at once — 73 → 109 of them over a second
 * pass of 198 slide switches, ~1,000 more nodes kept, a different number
 * every session (memory.slide.switch; heap snapshots: XMLDocument,
 * SVGImage, ImageResource held by `HTMLImageLoader` ← the pooled `image`).
 *
 * Once a raster's pixels are copied onto its texture's own canvas, nothing
 * reads the pooled image again until the next raster sets its `src`, so it
 * is emptied then — only while it is still in the pool: one another raster
 * took meanwhile holds that raster's SVG. `Pool.return` and `Pool.get` call
 * an item's `reset` and `init` (Pixi's own hooks; HTMLTextRenderData has
 * neither), which is how the pool is followed.
 */
/** Pooled raster images (followRenderDataPool), with their render data. */
const pooledRasters = new WeakMap<HTMLImageElement, { domElement: Element }>()

export function followRenderDataPool(): void {
  const proto = (HTMLTextRenderData as { prototype?: unknown } | undefined)?.prototype as
    | {
        reset?: (this: RenderDataLike) => void
        init?: (this: RenderDataLike, data?: unknown) => void
        [PATCHED]?: true
      }
    | undefined
  if (proto === undefined || proto[PATCHED] === true) return
  const reset = proto.reset
  const init = proto.init
  proto.reset = function (this: RenderDataLike): void {
    reset?.call(this)
    if (this.image instanceof HTMLImageElement) pooledRasters.set(this.image, this)
  }
  proto.init = function (this: RenderDataLike, data?: unknown): void {
    init?.call(this, data)
    if (this.image instanceof HTMLImageElement) pooledRasters.delete(this.image)
  }
  proto[PATCHED] = true
}

interface RenderDataLike {
  image: unknown
  domElement: Element
}

/** Empty a pooled raster image whose pixels its texture has copied (see `pooledRasters`). */
export function releasePooledRaster(image: HTMLImageElement): void {
  const data = pooledRasters.get(image)
  if (data === undefined) return
  pooledRasters.delete(image)
  // Not `src = ''`: an empty src resolves against the page's URL.
  image.removeAttribute('src')
  data.domElement.replaceChildren()
}

interface DeferredUploads {
  /** Rasters of this renderer's HTMLText system in flight. */
  building: number
  /** Sources whose upload from the pooled image was held back, to be uploaded by the raster. */
  sources: WeakSet<object>
  /** Sources a raster left holding the image: uploaded as Pixi would, never held back again. */
  keepImage: WeakSet<object>
  /** The texture system's own upload. */
  upload: (source: unknown) => void
  /** Canvases a raster is still filling: an upload from one waits for the raster. */
  provisional: WeakSet<object>
}

const DEFERRED = new WeakMap<object, DeferredUploads>()

/**
 * Hold back the upload Pixi makes from the pooled `<img>` of an HTMLText
 * raster (`getPo2TextureFromSource` emits `update`, `_buildTexturePromise`
 * calls `initSource`, either uploads it, a mipmap with it). The raster then
 * copies that image onto a canvas of its own and uploads that
 * (`patchHTMLTextRace`), and the canvas is what the texture is drawn with:
 * the first upload was never seen, and it doubled every text's uploads — and
 * an SVG image is rasterised for each (performance.md → E5: 192 uploads for
 * 96 table cells). Only sources holding Pixi's raster image while a raster
 * of this renderer runs are held back; the raster uploads each one exactly
 * once, the canvas or, when it keeps the image, the image.
 *
 * The texture system's listener is the instance's `onSourceUpdate`, read
 * when a source is first initialised (`_initSource`), so this goes in before
 * the renderer's first text.
 */
function deferPooledImageUploads(renderer: Renderer): DeferredUploads {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's GlTextureSystem internals
  const textures = (renderer as any).texture as
    { onSourceUpdate?: (source: TextureSourceLike) => void } | undefined
  const known = DEFERRED.get(renderer)
  if (known !== undefined) return known
  const upload = textures?.onSourceUpdate
  const state: DeferredUploads = {
    building: 0,
    sources: new WeakSet(),
    keepImage: new WeakSet(),
    provisional: new WeakSet(),
    upload: (source) => upload?.call(textures, source as TextureSourceLike),
  }
  DEFERRED.set(renderer, state)
  if (textures === undefined || typeof upload !== 'function') return state
  const deferring = function (this: unknown, source: TextureSourceLike): void {
    const r = source.resource
    if (typeof r === 'object' && r !== null && state.provisional.has(r)) {
      state.sources.add(source as object)
      return
    }
    if (
      state.building > 0 &&
      !state.keepImage.has(source as object) &&
      r instanceof HTMLImageElement &&
      r.src.startsWith(PIXI_SVG_RASTER_URL)
    ) {
      state.sources.add(source as object)
      return
    }
    upload.call(this, source)
  }
  textures.onSourceUpdate = deferring
  // The sources the system follows already (Texture.EMPTY, bound to every
  // unit when the context arrived, before this patch) listen with the
  // method itself; `onSourceUnload` removes `update` / `resize` listeners by
  // the instance's current function, which would match none of them. Each
  // destroyed renderer then stayed subscribed to Pixi's page-wide
  // Texture.EMPTY, and through its GL context and canvas kept the whole
  // editor it drew — DOM, React tree, listeners: ~600 nodes and ~90
  // listeners a deck opened (memory.deck.reopen, performance.md → E8).
  // Those listeners move to the function that removal will look for.
  rebindSourceListeners(textures, upload, deferring)
  return state
}

/** A texture source as far as its listeners go (Pixi's EventEmitter). */
interface ListeningSource {
  listenerCount(event: string): number
  on(event: string, fn: (...a: never[]) => void, context: unknown): unknown
  off(event: string, fn: (...a: never[]) => void, context: unknown): unknown
}

/**
 * Move `system`'s `update` and `resize` listeners from `from` to `to` on
 * every source it already follows (`_managedTextures`, GlTextureSystem):
 * only where `from` was listening for `system`, so no listener is added
 * that was not there.
 */
export function rebindSourceListeners(
  system: object,
  from: (...a: never[]) => void,
  to: (...a: never[]) => void,
): void {
  const managed = (system as { _managedTextures?: { items?: Record<string, unknown> } })
    ._managedTextures?.items
  if (managed === undefined) return
  for (const source of Object.values(managed)) {
    if (source === null || typeof source !== 'object') continue
    const s = source as Partial<ListeningSource>
    if (typeof s.listenerCount !== 'function' || typeof s.on !== 'function') continue
    for (const event of ['update', 'resize']) {
      const before = s.listenerCount(event)
      s.off!(event, from, system)
      if (s.listenerCount(event) < before) s.on(event, to, system)
    }
  }
}

export function patchHTMLTextRace(
  renderer: Renderer,
  opts: {
    wakeRenderScheduler: boolean
    /** Prefix of the perf counters (docs/plans/perf-harness.md): `text` on the editor canvas, `thumb.text` offscreen. */
    counters?: 'text' | 'thumb.text'
  } = { wakeRenderScheduler: false },
): void {
  const counters = opts.counters ?? 'thumb.text'
  const started = `${counters}.raster.started`
  const finished = `${counters}.raster.finished`
  const kpx = `${counters}.raster.kpx`
  const fontKb = `${counters}.raster.fontKb`
  const safariDelay = `${counters}.raster.safariDelay`
  // TEMP: regression-test bypass — set window.__disableHtmlTextRacePatch
  // before app init to skip this patch and confirm the test catches
  // the underlying Pixi race. Production never sets this.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis as any).__disableHtmlTextRacePatch === true) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pixi system is dynamic
  const system = (renderer as any).htmlText as HTMLTextSystemLike | undefined
  if (system === undefined) return
  if (system[PATCHED] === true) return
  // If pixi already snapshots to canvas (WebGPU), the bug doesn't
  // apply. Bail.
  if (system._createCanvas === true) {
    system[PATCHED] = true
    return
  }

  const wake = (): void => {
    if (!opts.wakeRenderScheduler) return
    try {
      markRenderDirty()
    } catch {
      // Best-effort.
    }
  }
  const deferred = deferPooledImageUploads(renderer)
  followRenderDataPool()
  const original = system._buildTexturePromise.bind(system)
  const rasterOne = async (options: unknown): Promise<unknown> => {
    perfCount(started)
    if (perfCountersOn()) void countEmbeddedFonts(options, fontKb, safariDelay)
    deferred.building++
    let texture: TextureLike | undefined
    try {
      texture = (await original(options)) as TextureLike | undefined
    } finally {
      deferred.building--
    }
    perfCount(finished)
    if (texture === undefined || texture === null) return texture
    const src = texture.source
    if (src === undefined || src === null) return texture
    // The upload Pixi would have made from the pooled image was held back
    // (`deferPooledImageUploads`); whichever resource the texture ends up
    // with, it is uploaded once, below.
    const held = deferred.sources.delete(src)
    const uploadAsIs = (): TextureLike => {
      deferred.keepImage.add(src)
      if (held) deferred.upload(src)
      return texture
    }

    const resource = src.resource
    if (!(resource instanceof HTMLImageElement)) return uploadAsIs()

    const w = resource.naturalWidth
    const h = resource.naturalHeight
    if (w === 0 || h === 0) return uploadAsIs()
    perfCount(kpx, Math.round((w * h) / 1000))

    // Detach: copy the pooled <img>'s pixels to an independent
    // <canvas> and rebind the texture to it. The canvas is held only
    // by this texture, so the pool can reuse the <img> freely.
    // As large as the whole pooled texture (`wholeTextureCanvas`).
    const canvas = wholeTextureCanvas(resource, w, h, src)
    if (canvas === null) return uploadAsIs()
    src.resource = canvas
    src.uploadMethodId = 'image'
    // Wake the GL upload so the renderer re-binds against the canvas.
    try {
      src.emit('update', src)
    } catch {
      // Best-effort — older pixi versions may differ.
    }
    // The texture draws from its canvas now: the pooled image can let go of its SVG.
    releasePooledRaster(resource)
    // The texture promise typically resolves AFTER the render frame
    // that triggered it. Without a follow-up render, any HTMLText that
    // first appears during a multi-text mount (e.g. five duplicate
    // component instances mounting in one frame after a deck reload)
    // ends up with `batchableHTMLText.texture = await texturePromise`
    // landing into an idle scheduler — the user sees the node as
    // empty until ANY unrelated mutation triggers the next paint
    // ("they all load when I move something"). Pinging the scheduler
    // here guarantees that every successful HTMLText texture build
    // gets at least one paint, regardless of how many other nodes
    // are racing to rasterise in the same frame. Skipped for offscreen
    // pipelines (thumbnails) which drive their own renders.
    wake()
    return texture
  }
  // A table's cells share their SVGs (renderer/htmlTextGroupRaster.ts); a
  // cell rasterised alone goes through `rasterOne` like every other text.
  const grouped = createGroupRaster(renderer, {
    onRaster({ px, fontKb: kb, safariDelay: delayed }) {
      perfCount(started)
      perfCount(kpx, Math.round(px / 1000))
      perfCount(fontKb, kb)
      if (delayed) perfCount(safariDelay)
    },
    onReady() {
      perfCount(finished)
      wake()
    },
    single: (text) => rasterOne(text) as Promise<Texture>,
    texture(pixels, width, height, make) {
      // Pixi's pooled texture for the cell, its upload held until the
      // canvas covers the whole texture; then one upload.
      deferred.provisional.add(pixels)
      const texture = make(pixels)
      deferred.provisional.delete(pixels)
      const src = texture.source as unknown as TextureLike['source']
      deferred.sources.delete(src)
      const whole = wholeTextureCanvas(pixels, width, height, src) ?? pixels
      src.resource = whole
      src.uploadMethodId = 'image'
      deferred.upload(src)
      return texture
    },
  })
  system._buildTexturePromise = function (options: unknown): Promise<unknown> {
    const group = htmlTextRasterGroup(options)
    return group === undefined ? rasterOne(options) : grouped.request(options, group)
  }
  system[PATCHED] = true
}
