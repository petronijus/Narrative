/**
 * renderer/thumbnails.ts
 *
 * Slide thumbnail renderer — rasterises a SlideObject[] to a PNG blob.
 *
 * Design:
 * - One shared offscreen Pixi Application per ThumbnailRenderer instance,
 *   drawing into one render texture of the picture's size (never onto its
 *   own canvas, which stays 1×1), anti-aliased (MSAA). The size is the
 *   renderer's `width` or the one a render asks for — the size the picture
 *   is shown at (ui/useThumbnailPixelWidth.ts). Until F10 every picture came
 *   out 1920 × 1080 whatever was asked: Pixi's `extract.canvas(container)`
 *   reads a container's local bounds, before its scale.
 * - Each renderSlide() call builds a temporary Container scaled so that the
 *   1920×1080 slide fits the thumbnail, pipes SlideObject[] through the same
 *   objectRenderers registry (thumbnailMount() / mount()), waits for its
 *   pictures and text rasters, draws it, queues the read-back of the pixels
 *   and destroys the container. The read (a pixel-pack buffer behind a fence,
 *   captureSlide.ts → queueTextureReadback) and the PNG encode finish while
 *   the next thumbnail is already being mounted: the main thread never waits
 *   for the GPU, and the GPU's work of one thumbnail overlaps the CPU's of
 *   the next.
 * - Concurrent renderSlide() calls are serialised through a Promise chain so
 *   two renders never share the render texture.
 * - Pictures (image objects, image backgrounds) come from the renderer's own
 *   cache (thumbnailPictures.ts): loaded, decoded and uploaded once per
 *   renderer, not once per thumbnail. The editor's ResourceManager cannot
 *   lend them: this renderer has a WebGL context of its own.
 * - Text is rasterised at the size it is drawn at, twice over
 *   (`TEXT_OVERSAMPLE`) and never below half its font size
 *   (`MIN_TEXT_RESOLUTION`), not at the slide's own size: a panel row shows
 *   a 1920-wide slide ~224 px wide (performance.md → F10).
 *
 * Limitations:
 * - WebGL is required. Environments without WebGL (e.g. plain jsdom without canvas mock)
 *   will cause Application.init() to reject. Tests stub createThumbnailRenderer().
 * - Only object types registered in rendererRegistry are rendered; unknown types are skipped.
 * - `resolution` multiplies the width; callers pass the device-pixel width
 *   they want and resolution 1.
 */

// Pixi generates shader/uniform sync code with `new Function`, which the
// production CSP (`script-src 'self'`, no `unsafe-eval`) blocks — the renderer
// then throws "Current environment does not allow unsafe-eval" during
// `app.init()` and the canvas stays empty. This side-effect import swaps that
// codegen for Pixi's official eval-free polyfills. It MUST be evaluated before
// any `Application` is constructed, hence the module-level import here.
// Dev has no CSP, so this only ever mattered in prod.
import { collectHtmlTextRasters } from './htmlTextRaster.js'
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, HTMLText, RenderTexture } from 'pixi.js'
import { getRenderer } from './objectRenderers/index.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import { getThumbnailReady } from './thumbnailReady.js'
import { stripFilterEffectsTree } from './filterEffects.js'
import { applyBackground, releaseBackground } from './ArtboardBackground.js'
import { getDefaultImageUrlResolver } from './imageUrl.js'
import { releaseOwnedGraphicsContexts } from './graphicsContextRelease.js'
import { patchHTMLTextRace } from './patchHTMLTextRace.js'
import { installRunText } from './runText/runTextSystem.js'
import { destroyPixiApplication } from './pixiApplication.js'
import { DEFAULT_BACKGROUND, perfCount, perfCountersOn } from '@narrative/shared'
import type { SlideBackground, SlideObject } from '@narrative/shared'
import { setRenderingSlideNumber } from './slideNumberContext.js'
import { withRenderingSurface } from './colourResolver.js'
import { canvasToPng, queueTextureReadback } from './captureSlide.js'
import { createThumbnailPictures, withThumbnailPictures } from './thumbnailPictures.js'

/**
 * A User Timing span (`thumb.<phase>`) of one phase of a thumbnail, while the
 * perf harness counts (`?perf=1`): where a deck's thumbnail time goes, per
 * engine, without a profiler (WebKit under Playwright has none).
 */
function span(name: string, start: number): number {
  const end = performance.now()
  if (perfCountersOn()) performance.measure(`thumb.${name}`, { start, end })
  return end
}

/**
 * Raster pixels per picture pixel of a text: sampled down 2:1 (mipmapped),
 * its edges as smooth as the slide-size raster shrunk by the browser was.
 */
export const TEXT_OVERSAMPLE = 2
/**
 * Raster pixels per CSS pixel of a text, at least: a glyph is never
 * rasterised below half its font size. Smaller, the browser's small-size
 * rendering thins the strokes, and a 1× panel's text came out visibly lighter
 * than the slide-size raster shrunk by the browser (F10, sampled pictures:
 * mean difference to it 3.8 → 3.3 levels with this floor, 2.5 with MSAA too).
 */
const MIN_TEXT_RESOLUTION = 0.5

/**
 * Give every HTMLText under `node` the resolution it is drawn at (`scale`:
 * device px per unit of `node`'s parent) times `TEXT_OVERSAMPLE`, at least
 * `MIN_TEXT_RESOLUTION`, never more than `cap` (the renderer's own
 * resolution: what Pixi would have used).
 * Before the first frame: the first frame starts each raster at the
 * resolution it then has.
 */
export function fitTextResolutions(node: Container, scale: number, cap: number): void {
  const s = scale * Math.max(Math.abs(node.scale.x), Math.abs(node.scale.y))
  if (node instanceof HTMLText) {
    node.resolution = Math.min(cap, Math.max(MIN_TEXT_RESOLUTION, s * TEXT_OVERSAMPLE))
  }
  for (const child of node.children) fitTextResolutions(child as Container, s, cap)
}

/** Read-backs in flight before the next thumbnail waits for the oldest. */
const MAX_PENDING_READS = 4

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ThumbnailOptions {
  /**
   * Output width in CSS pixels. Height is derived from the 16:9 slide aspect ratio.
   * Default: 200.
   */
  width?: number
  /**
   * Device pixel ratio for the rendered bitmap. Default: 1.
   * Increase to 2 on HiDPI displays if thumbnails appear blurry.
   * Trade-off: 2× resolution = 4× pixel work.
   */
  resolution?: number
}

/**
 * Stateful thumbnail renderer backed by a single offscreen Pixi Application.
 * Obtain via createThumbnailRenderer(). Call destroy() when done.
 */
export interface ThumbnailRenderer {
  /**
   * Renders a slide's object list to a PNG (renderer/thumbnailImages.ts makes its URL).
   *
   * Async: waits for any in-progress render to finish before starting a new one
   * (serialised queue — safe to call concurrently from multiple slide subscriptions).
   *
   * Rejects if the renderer has been destroyed.
   *
   * P2: `background` is painted first underneath objects. `undefined`
   * leaves the canvas transparent so the SlidesPanel's card bg shows
   * through (matches the pre-P2 behaviour).
   */
  renderSlide(
    objects: SlideObject[],
    background?: SlideBackground,
    slideNumber?: number,
    /** The slide's surface (its layout's, A4.2d): its colour tokens resolve on it. */
    surface?: string,
    /** The picture's width in pixels (before `resolution`); default: the renderer's `width`. */
    width?: number,
  ): Promise<Blob>

  /**
   * Destroys the underlying offscreen Pixi Application and releases GPU resources.
   * Subsequent calls to renderSlide() will reject with an error.
   */
  destroy(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and initialises a ThumbnailRenderer.
 *
 * The returned renderer holds an offscreen Pixi Application.
 * Call destroy() when the component that owns this renderer unmounts.
 *
 * @param opts Optional configuration for width and resolution.
 */
export async function createThumbnailRenderer(opts?: ThumbnailOptions): Promise<ThumbnailRenderer> {
  const defaultWidth = opts?.width ?? 200
  const resolution = opts?.resolution ?? 1

  // Offscreen Pixi Application — WebGL preferred, transparent background.
  // autoDensity:false means canvas CSS size = logical size (no extra scaling layer).
  const app = new Application()
  await app.init({
    // Never drawn on: every frame goes into `target` below.
    width: 1,
    height: 1,
    backgroundAlpha: 0,
    autoDensity: false,
    resolution,
    preference: 'webgl',
    // Prevent Pixi from attaching the canvas to document.body
    antialias: false,
    // Offscreen app: we drive renders synchronously. Without this the rAF
    // ticker also renders between our call and the extract, and a
    // filter crash on a later tick leaks out as an Uncaught TypeError.
    autoStart: false,
    sharedTicker: false,
  })
  // Same Pixi WebGL HTMLText race fix as the main canvas — without
  // this, thumbnail mounts that render multiple text leaves can leak
  // each other's pooled <img> into one another's textures.
  patchHTMLTextRace(app.renderer)
  installRunText(app.renderer, { wakeRenderScheduler: false, counters: 'thumb.text' })
  // A Graphics destroyed with its tree releases its own context (graphicsContextRelease.ts).
  releaseOwnedGraphicsContexts()

  /**
   * What every frame draws into, and the read-backs read from: the picture's
   * size, made again when a render asks for another width. (A read still
   * pending from the old one is not disturbed: GL keeps a texture deleted
   * after a queued read alive until the read is done.)
   */
  let target: RenderTexture | null = null
  let targetWidth = 0
  const targetFor = (width: number): RenderTexture => {
    if (target !== null && targetWidth === width) return target
    target?.destroy(true)
    targetWidth = width
    target = RenderTexture.create({
      width,
      // A whole number of rows: 1080 × 200/1920 = 112.5 → 113 (as Pixi's extract rounded).
      height: Math.max(1, Math.round((SLIDE_HEIGHT * width) / SLIDE_WIDTH)),
      resolution,
      // Edges anti-aliased (MSAA, resolved before the read): the picture used to
      // be the slide at its own size shrunk by the browser, whose edges blend.
      antialias: true,
      // Read back as drawn; the page's default (Canvas.tsx) would add mipmaps per frame.
      autoGenerateMipmaps: false,
    })
    return target
  }
  const pictures = createThumbnailPictures()
  /** Read-backs and encodes still running, oldest first. */
  const pendingReads: Promise<unknown>[] = []

  let destroyed = false
  const gone = (): Error => new Error('[ThumbnailRenderer] renderer has been destroyed')

  // Serialisation queue — ensures the offscreen canvas is not shared across concurrent renders.
  // Each renderSlide() chains onto this promise so calls execute one-at-a-time.
  let renderQueue: Promise<void> = Promise.resolve()

  // ---------------------------------------------------------------------------
  // Internal render implementation
  // ---------------------------------------------------------------------------

  /**
   * One synchronous frame of the offscreen app. A frame that throws abandons
   * this thumbnail (its temporary container goes with it) and the queue moves
   * on; the next render adds a new container, so the stage's instructions are
   * rebuilt from scratch.
   *
   * It is reported as a render failure, not as teardown: callers stay quiet
   * about "renderer has been destroyed" only (useSlideThumbnails), and
   * labelling every Pixi exception that way once hid that Pixi's page-wide
   * pools had been released under this renderer (pixiApplication.ts) — its
   * thumbnails silently stopped updating.
   */
  function renderFrame(target: RenderTexture, dispose: () => void): void {
    try {
      app.renderer.render({ container: app.stage, target, clear: true })
    } catch (err) {
      dispose()
      throw new Error(
        `[ThumbnailRenderer] render failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  }

  async function renderSlideInternal(
    objects: SlideObject[],
    background: SlideBackground | undefined,
    slideNumber: number | undefined,
    surface: string | undefined,
    width: number,
  ): Promise<{ picture: Promise<Blob> }> {
    // Map the 1920-wide slide into `width` pixels.
    const scale = width / SLIDE_WIDTH
    // Set the page-number context so any text leaf flagged
    // `isSlideNumber` rasterises with this slide's value. Cleared
    // before any await — concurrent thumbnail renders are serialised
    // through `renderQueue`, so we never have two slides racing for the
    // global, but we still defensively reset on each call.
    setRenderingSlideNumber(slideNumber)
    let t = performance.now()
    // Build a temp container that holds the full slide content scaled to thumbnail size.
    const slideContainer = new Container()
    // Scale the entire slide down to thumbnail dimensions.
    slideContainer.scale.set(scale)

    // P3: clip thumbnail content to the artboard rect so objects dragged
    // outside the slide in the editor don't leak into the sidebar preview.
    // Using a Graphics mask in SLIDE space — the mask is scaled together
    // with slideContainer so the clip matches the artboard visually.
    const clipMask = new Graphics()
    clipMask.rect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT)
    clipMask.fill({ color: 0xffffff })
    slideContainer.addChild(clipMask)
    slideContainer.mask = clipMask

    // P2/P3: paint the artboard background first so objects stack above
    // it. The thumbnail always shows the artboard fill — if the caller
    // didn't pass a background (pre-P2 slide), we fall back to
    // DEFAULT_BACKGROUND so the panel card shows the same artboard
    // area the editor does, not a transparent placeholder.
    //
    // For IMAGE backgrounds we must:
    //   1. Hand applyBackground a `resolveAssetUrl` — without one,
    //      `mountImageBackground` silently returns and the slide panel
    //      tile shows the bare slide content with no background.
    //   2. Await the resulting promise so the async sprite mount lands
    //      BEFORE the one-shot extract below. Otherwise the
    //      PNG we capture has the background container empty.
    //
    // The thumbnail renderer doesn't share a ResourceManager with the
    // main canvas (textures here are tied to this offscreen Pixi app's
    // lifetime — destroyed alongside `app`), so the acquire/release
    // hooks stay unset and `mountImageBackground` falls through to its
    // direct `Image.decode() + Texture.from(img)` path.
    // Collect async work that must finish before the one-shot extract
    // below: image-background decode + each object renderer's thumbnailMount
    // ready promise. Declared above the bg block so the bg's promise can
    // be pushed alongside the per-object ones.
    const readyPromises: Promise<unknown>[] = []
    const backgrounds: Container[] = []
    // P12g: remember which renderer mounted each child so the destroy
    // pass routes through `renderer.destroy()` instead of Pixi's generic
    // `Container.destroy({ children: true })`. Without it, image / video
    // child containers leaked their textures every render.
    const mounted: Array<{ node: Container; type: string }> = []

    /** Take the thumbnail apart: every object through its renderer, the background released. */
    const dispose = (): void => {
      app.stage?.removeChild(slideContainer)
      for (const bg of backgrounds) releaseBackground(bg, (url) => pictures.release(url))
      for (const { node, type } of mounted) {
        if (node.destroyed) continue
        const renderer = getRenderer(type)
        if (renderer !== undefined) {
          try {
            renderer.destroy(node)
          } catch (err) {
            console.error(`[thumbnails] renderer.destroy(${type}) threw`, err)
            if (!node.destroyed) node.destroy({ children: true })
          }
        } else if (!node.destroyed) {
          node.destroy({ children: true })
        }
      }
      if (!slideContainer.destroyed) slideContainer.destroy({ children: true })
    }

    const effectiveBackground: SlideBackground = background ?? DEFAULT_BACKGROUND
    const bgResolver = (() => {
      try {
        return getDefaultImageUrlResolver()
      } catch {
        return null
      }
    })()
    {
      const bgContainer = new Container()
      slideContainer.addChild(bgContainer)
      const bgReady = applyBackground({
        container: bgContainer,
        background: effectiveBackground,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        ...(bgResolver !== null
          ? { resolveAssetUrl: (assetId) => bgResolver({ assetId, variant: 'display' }) }
          : {}),
        acquireTexture: (url) => pictures.acquire(url),
        releaseTexture: (url) => pictures.release(url),
      })
      backgrounds.push(bgContainer)
      // Wait for the image background's async decode before the one-shot
      // render below. Color + gradient backgrounds resolve synchronously,
      // so this is effectively a no-op for those.
      readyPromises.push(bgReady)
    }

    // Mount each object through the registry (same path as the main SceneGraph).
    // Prefer thumbnailMount() when available. thumbnailMount MAY attach a
    // ready-promise (via setThumbnailReady) — for async content like image
    // rasters or video posters, we must wait for those to resolve before
    // taking the one-shot render frame, otherwise the PNG captures only the
    // grey placeholder.
    for (const obj of objects) {
      const renderer = getRenderer(obj.type)
      if (renderer === undefined) {
        // Unknown type — silently skip (same policy as SceneGraph.addObject).
        continue
      }
      const mountFn = renderer.thumbnailMount ?? renderer.mount
      // Colours are read while mounting: on this slide's surface, without
      // repainting the editor's canvas (which shows another slide).
      const node = withThumbnailPictures(pictures, () =>
        withRenderingSurface(surface, () => mountFn.call(renderer, obj)),
      )
      slideContainer.addChild(node)
      mounted.push({ node, type: obj.type })
      const ready = getThumbnailReady(node)
      if (ready !== undefined) readyPromises.push(ready)
    }

    // Await all async mounts (image decode, video-info fetch). Each ready-
    // promise is already wrapped in its own try/catch inside thumbnailMount,
    // so a single failed asset does not reject the whole render.
    t = span('mount', t)
    if (readyPromises.length > 0) {
      await Promise.allSettled(readyPromises)
    }
    t = span('ready', t)

    // The app may have been destroyed during the await above (e.g. the
    // user navigated to present mode while thumbnails were still being
    // rendered). Abort instead of touching a torn-down renderer.
    if (destroyed || app.renderer === null) {
      dispose()
      throw gone()
    }

    // P5c: DropShadowFilter + BlurFilter crash the offscreen thumbnail
    // renderer (BindGroup.setResource null deref). Strip every filter from
    // the subtree before rendering — thumbnails accept the loss of shadow
    // and blur in exchange for a render that actually succeeds.
    stripFilterEffectsTree(slideContainer)

    // Text rasters at the size the thumbnail shows them (TEXT_OVERSAMPLE).
    fitTextResolutions(slideContainer, resolution, app.renderer.resolution)

    app.stage.addChild(slideContainer)

    // Render one frame synchronously — the offscreen app is not running a ticker.
    const target = targetFor(width)
    renderFrame(target, dispose)
    t = span('frame1', t)

    // Pixi v8's HTMLText rasterizes its SVG asynchronously. The first
    // render() above kicks off that work but the Texture is still EMPTY
    // when render returns, so the extracted PNG is missing every text
    // glyph. Walk the subtree, await each HTMLText's texturePromise (set
    // on `_gpuData[renderer.uid]` after the first render dispatch), then
    // render a second frame so the now-loaded glyph textures actually
    // appear in the bitmap we extract.
    const textPromises = collectHtmlTextRasters(slideContainer, app.renderer.uid)
    if (textPromises.length > 0) {
      await Promise.allSettled(textPromises)
      t = span('text', t)
      if (destroyed || app.renderer === null) {
        dispose()
        throw gone()
      }
      renderFrame(target, dispose)
      t = span('frame2', t)
    }

    // The frame's pixels: queued now, in GL order (what the next thumbnail
    // draws into `target` does not reach them), read and encoded while the
    // next thumbnail is mounted. Without WebGL2, read at once.
    const queued = queueTextureReadback(app.renderer, target, {
      cpuCanvas: true,
      lost: () => destroyed,
    })
    const canvas: Promise<HTMLCanvasElement | OffscreenCanvas> =
      queued ??
      Promise.resolve(app.renderer.extract.canvas(target) as HTMLCanvasElement | OffscreenCanvas)
    t = span('extract', t)

    // The container can go now: the read is queued behind its draws.
    dispose()
    span('destroy', t)

    const encodeStart = performance.now()
    const picture = canvas.then(
      async (c) => {
        if (destroyed) throw gone()
        const png = await canvasToPng(c)
        span('readEncode', encodeStart)
        return png
      },
      (err: unknown) => {
        throw destroyed ? gone() : err
      },
    )
    return { picture }
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    renderSlide(
      objects: SlideObject[],
      background?: SlideBackground,
      slideNumber?: number,
      surface?: string,
      width?: number,
    ): Promise<Blob> {
      if (destroyed) {
        return Promise.reject(new Error('[ThumbnailRenderer] renderer has been destroyed'))
      }

      // Chain onto the serialisation queue.
      // Each render runs only after the previous one resolves/rejects.
      let resolveRender!: (value: Blob) => void
      let rejectRender!: (reason: unknown) => void

      const resultPromise = new Promise<Blob>((resolve, reject) => {
        resolveRender = resolve
        rejectRender = reject
      })

      renderQueue = renderQueue
        .then(() => {
          if (destroyed) {
            rejectRender(new Error('[ThumbnailRenderer] renderer has been destroyed'))
            return
          }
          try {
            perfCount('thumb.render')
            return renderSlideInternal(
              objects,
              background,
              slideNumber,
              surface,
              width ?? defaultWidth,
            ).then(async ({ picture }) => {
              picture.then(resolveRender, rejectRender)
              // The read and the encode run on; the next thumbnail starts
              // unless too many of them are still running.
              const settled = picture.then(
                () => undefined,
                () => undefined,
              )
              pendingReads.push(settled)
              void settled.then(() => {
                pendingReads.splice(pendingReads.indexOf(settled), 1)
              })
              if (pendingReads.length >= MAX_PENDING_READS) await pendingReads[0]
            }, rejectRender)
          } catch (err) {
            rejectRender(err)
          }
        })
        // Tail catch — guarantees the queue Promise stays in a fulfilled
        // state regardless of upstream errors, so the next render's
        // .then() chains correctly. Without this, an uncaught rejection
        // would freeze the whole queue and every subsequent renderSlide
        // would never resolve.
        .catch((err: unknown) => {
          console.error('[ThumbnailRenderer] queue tail caught:', err)
        })

      return resultPromise
    },

    destroy(): void {
      if (destroyed) return
      destroyed = true
      pictures.destroy()
      target?.destroy(true)
      // Destroy the offscreen Application and all GPU resources it holds —
      // but not Pixi's page-wide pools, which the editor canvas is drawing
      // with (pixiApplication.ts).
      destroyPixiApplication(app)
    },
  }
}
