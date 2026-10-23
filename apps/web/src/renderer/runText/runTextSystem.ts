/**
 * renderer/runText/runTextSystem.ts — a renderer's HTMLText rasters drawn
 * from glyph runs (ADR 0018).
 *
 * Pixi's HTMLText pipe asks the renderer's `htmlText` system for a text's
 * texture (`getTexturePromise(text)`) and hands the old one back when it has
 * a new one (`returnTexturePromise`). Those two public methods are wrapped on
 * the renderer's own system instance — Pixi's extension point for a system is
 * its interface, and the pipe, the bounds, the batching and everything that
 * waits for a raster (`_gpuData[uid].texturePromise`: thumbnails, present
 * mode, the render page, the zoom staging, the realignment) stay as they are:
 *
 *   1. the text's layout (`layoutCache.ts`: usually already there, the
 *      node's bounds were measured from it);
 *   2. painted at the text's resolution in a worker (`textRasterPool.ts`);
 *   3. an exact-size texture made of the bitmap, uploaded at once (as Pixi
 *      uploads its raster when it lands), owned by this module: destroyed when
 *      the pipe returns it — never put into Pixi's power-of-two `TexturePool`.
 *
 * A text the run painter cannot draw as the engine does (`layout.unsupported`,
 * or a paint that fails) is rasterised by Pixi's own path instead — the
 * system's original method, with the race patch and the table grouping
 * around it (patchHTMLTextRace.ts). Its texture goes back to Pixi as before.
 */

import { ImageSource, Texture, TextureSource } from 'pixi.js'
import type { HTMLText, Renderer } from 'pixi.js'
import { perfCount } from '@narrative/shared'
import { perfAvailable } from '../../perf/activation.js'
import { markRenderDirty } from '../RenderScheduler.js'
import { setHtmlTextMeasurer } from '../htmlTextBoundsMemo.js'
import { runTextEnabled } from './flag.js'
import type { TextDiff } from './fidelityProbe.js'
import { engineRules, measureWithRunLayout, runLayoutFor } from './layoutCache.js'
import { textRasterPool } from './textRasterPool.js'

interface HtmlTextSystemLike {
  getTexturePromise(options: unknown): Promise<Texture>
  returnTexturePromise(texturePromise: Promise<Texture>): void
}

const INSTALLED = Symbol('narrative.runTextSystem')

/** Textures this module made (and so destroys), with the bitmap behind each. */
const RUN_TEXTURES = new WeakMap<Texture, ImageBitmap>()

/** Live run-text textures and their pixels, per counter prefix (the harness and tests read them). */
export const runTextureStats = { count: 0, pixels: 0 }

export interface RunTextOptions {
  /** Ask the editor's render scheduler for a frame when a raster lands (not offscreen renderers). */
  wakeRenderScheduler: boolean
  /** Prefix of the perf counters: `text` on the editor canvas, `thumb.text` offscreen. */
  counters: 'text' | 'thumb.text'
}

/**
 * Measure every HTMLText of the page with the run layout (when the page draws
 * text from runs). Called at import by `objectRenderers/textRenderer.ts`,
 * before any text exists.
 */
export function installRunTextMeasurement(): void {
  if (runTextEnabled()) setHtmlTextMeasurer(measureWithRunLayout)
}

/** The raster's texture: the bitmap as an exact-size source, uploaded now. */
function runTexture(
  renderer: Renderer | null,
  bitmap: ImageBitmap,
  resolution: number,
  text: HTMLText,
): Texture {
  const source = new ImageSource({
    resource: bitmap,
    resolution,
    alphaMode: 'premultiply-alpha-on-upload',
    autoGenerateMipmaps:
      text.autoGenerateMipmaps ?? TextureSource.defaultOptions.autoGenerateMipmaps ?? false,
    ...(text.textureStyle?.scaleMode !== undefined
      ? { scaleMode: text.textureStyle.scaleMode }
      : {}),
  })
  const texture = new Texture({ source })
  RUN_TEXTURES.set(texture, bitmap)
  runTextureStats.count++
  runTextureStats.pixels += bitmap.width * bitmap.height
  // As Pixi's own raster: uploaded when it lands (not by the frame that draws
  // it), unless the renderer went away meanwhile.
  renderer?.texture.initSource(source)
  return texture
}

function destroyRunTexture(texture: Texture): void {
  const bitmap = RUN_TEXTURES.get(texture)
  if (bitmap === undefined) return
  RUN_TEXTURES.delete(texture)
  runTextureStats.count--
  runTextureStats.pixels -= bitmap.width * bitmap.height
  // Destroying the stage with its textures may have got here first.
  if (!texture.destroyed) texture.destroy(true)
  bitmap.close()
}

/** Whether `texture` is a run-text raster (tests, diagnostics). */
export function isRunTexture(texture: Texture | null | undefined): boolean {
  return texture !== null && texture !== undefined && RUN_TEXTURES.has(texture)
}

/**
 * Draw `renderer`'s HTMLText from glyph runs (when the page does). After
 * `app.init()` (the system exists) and after `patchHTMLTextRace`, whose
 * patched raster is the fallback. Idempotent.
 */
export function installRunText(renderer: Renderer, opts: RunTextOptions): void {
  if (!runTextEnabled()) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi's systems are untyped on Renderer
  const system = (renderer as any).htmlText as
    (HtmlTextSystemLike & { [INSTALLED]?: true }) | undefined
  if (system === undefined || system[INSTALLED] === true) return
  system[INSTALLED] = true
  const getHtml = system.getTexturePromise.bind(system)
  const returnHtml = system.returnTexturePromise.bind(system)
  const started = `${opts.counters}.raster.started`
  const finished = `${opts.counters}.raster.finished`
  const kpx = `${opts.counters}.raster.kpx`
  const fallback = `${opts.counters}.raster.fallback`
  const pool = textRasterPool()
  const paint = engineRules().paint

  const fromRuns = async (text: HTMLText): Promise<Texture> => {
    const resolution = text.resolution
    const layout = runLayoutFor(text.text, text.style)
    if (layout.unsupported !== undefined) {
      perfCount(fallback)
      return await getHtml(text)
    }
    perfCount(started)
    const painted = await pool.paint(layout, resolution, paint)
    if (painted === null) {
      perfCount(fallback)
      return await getHtml(text)
    }
    perfCount(finished)
    perfCount(kpx, Math.round((painted.bitmap.width * painted.bitmap.height) / 1000))
    if (painted.where === 'main') perfCount(`${opts.counters}.raster.mainThread`)
    // The system forgets its renderer when the renderer is destroyed (a slide
    // switch tearing down a thumbnail renderer mid-paint): nothing to upload to.
    const live = (system as { _renderer?: unknown })._renderer != null ? renderer : null
    const texture = runTexture(live, painted.bitmap, resolution, text)
    if (opts.wakeRenderScheduler) markRenderDirty()
    return texture
  }

  system.getTexturePromise = (options: unknown): Promise<Texture> => fromRuns(options as HTMLText)

  if (opts.counters === 'text' && perfAvailable()) exposeProbe(renderer, getHtml, returnHtml)

  system.returnTexturePromise = (texturePromise: Promise<Texture>): void => {
    texturePromise.then(
      (texture) => {
        if (RUN_TEXTURES.has(texture)) destroyRunTexture(texture)
        else returnHtml(Promise.resolve(texture))
      },
      () => {
        /* a failed raster has nothing to return; Pixi reports its own failures */
      },
    )
  }
}

/** What the e2e parity specs read (`window.__narrative_runText`, dev builds and `?perf=1`). */
export interface RunTextDebugApi {
  /** Every text on the editor canvas drawn both ways and compared (fidelityProbe.ts). */
  compare(): Promise<TextDiff[]>
  /** Live run-text textures. */
  stats(): { count: number; pixels: number; workers: number }
}

function exposeProbe(
  renderer: Renderer,
  htmlRaster: (text: unknown) => Promise<Texture>,
  returnHtml: (p: Promise<Texture>) => void,
): void {
  const api: RunTextDebugApi = {
    async compare() {
      const { compareTexts } = await import('./fidelityProbe.js')
      return await compareTexts(renderer, htmlRaster, returnHtml)
    },
    stats() {
      return { ...runTextureStats, workers: textRasterPool().workers }
    },
  }
  ;(globalThis as { __narrative_runText?: RunTextDebugApi }).__narrative_runText = api
}
