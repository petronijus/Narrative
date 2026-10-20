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

import { extractFontFamilies, getFontCss, isSafari } from 'pixi.js'
import type { HTMLTextStyle, Renderer } from 'pixi.js'
import { perfCount, perfCountersOn } from '@narrative/shared'
import { markRenderDirty } from './RenderScheduler.js'

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

  const original = system._buildTexturePromise.bind(system)
  system._buildTexturePromise = async function (options: unknown): Promise<unknown> {
    perfCount(started)
    if (perfCountersOn()) void countEmbeddedFonts(options, fontKb, safariDelay)
    const texture = (await original(options)) as TextureLike | undefined
    perfCount(finished)
    if (texture === undefined || texture === null) return texture
    const src = texture.source
    if (src === undefined || src === null) return texture

    const resource = src.resource
    if (!(resource instanceof HTMLImageElement)) return texture

    const w = resource.naturalWidth
    const h = resource.naturalHeight
    if (w === 0 || h === 0) return texture
    perfCount(kpx, Math.round((w * h) / 1000))

    // Detach: copy the pooled <img>'s pixels to an independent
    // <canvas> and rebind the texture to it. The canvas is held only
    // by this texture, so the pool can reuse the <img> freely.
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx === null) return texture
    ctx.drawImage(resource, 0, 0)
    src.resource = canvas
    src.uploadMethodId = 'image'
    // Wake the GL upload so the renderer re-binds against the canvas.
    try {
      src.emit('update', src)
    } catch {
      // Best-effort — older pixi versions may differ.
    }
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
    if (opts.wakeRenderScheduler) {
      try {
        markRenderDirty()
      } catch {
        // Best-effort.
      }
    }
    return texture
  }
  system[PATCHED] = true
}
