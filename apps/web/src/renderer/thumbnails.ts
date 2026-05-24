/**
 * renderer/thumbnails.ts
 *
 * Slide thumbnail renderer — rasterises a SlideObject[] to a PNG data URL.
 *
 * Design:
 * - One shared offscreen Pixi Application per ThumbnailRenderer instance.
 * - The app is scaled so that the full 1920×1080 slide fits inside opts.width × derived-height.
 * - Each renderSlide() call builds a temporary Container, pipes SlideObject[] through the
 *   same objectRenderers registry (mount()), renders the frame, extracts a base64 PNG, then
 *   destroys the temp container. The offscreen app is reused across calls.
 * - Concurrent renderSlide() calls are serialised through a Promise chain so the offscreen
 *   canvas is never used by two renders simultaneously.
 * - Textures from the main ResourceManager are NOT used here — thumbnails render shapes
 *   and text inline. This keeps the thumbnail renderer self-contained and lightweight.
 *
 * Performance target (M9):
 *   < 16 ms per render with 10 objects on mid-range hardware.
 *   Further optimisation deferred to M29.
 *
 * Limitations:
 * - WebGL is required. Environments without WebGL (e.g. plain jsdom without canvas mock)
 *   will cause Application.init() to reject. Tests stub createThumbnailRenderer().
 * - Only object types registered in rendererRegistry are rendered; unknown types are skipped.
 * - resolution=1 is intentional — thumbnails are cheap display-only assets.
 */

import { Application, Container, Graphics } from 'pixi.js'
import { getRenderer } from './objectRenderers/index.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import { getThumbnailReady } from './thumbnailReady.js'
import { stripFilterEffectsTree } from './filterEffects.js'
import { applyBackground } from './ArtboardBackground.js'
import { getDefaultImageUrlResolver } from './imageUrl.js'
import { patchHTMLTextRace } from './patchHTMLTextRace.js'
import { DEFAULT_BACKGROUND } from '@narrative/shared'
import type { SlideBackground, SlideObject } from '@narrative/shared'
import { setRenderingSlideNumber } from './slideNumberContext.js'

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
   * Renders a slide's object list to a PNG data URL.
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
  ): Promise<string>

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
  const outputWidth = opts?.width ?? 200
  const resolution = opts?.resolution ?? 1

  // Scale factor: map 1920-wide slide into outputWidth pixels.
  const scale = outputWidth / SLIDE_WIDTH
  const outputHeight = Math.round(SLIDE_HEIGHT * scale)

  // Offscreen Pixi Application — WebGL preferred, transparent background.
  // autoDensity:false means canvas CSS size = logical size (no extra scaling layer).
  const app = new Application()
  await app.init({
    width: outputWidth,
    height: outputHeight,
    backgroundAlpha: 0,
    autoDensity: false,
    resolution,
    preference: 'webgl',
    // Prevent Pixi from attaching the canvas to document.body
    antialias: false,
    // Offscreen app: we drive renders synchronously. Without this the rAF
    // ticker also renders between our call and extract.base64(), and a
    // filter crash on a later tick leaks out as an Uncaught TypeError.
    autoStart: false,
    sharedTicker: false,
  })
  // Same Pixi WebGL HTMLText race fix as the main canvas — without
  // this, thumbnail mounts that render multiple text leaves can leak
  // each other's pooled <img> into one another's textures.
  patchHTMLTextRace(app.renderer)

  let destroyed = false

  // Serialisation queue — ensures the offscreen canvas is not shared across concurrent renders.
  // Each renderSlide() chains onto this promise so calls execute one-at-a-time.
  let renderQueue: Promise<void> = Promise.resolve()

  // ---------------------------------------------------------------------------
  // Internal render implementation
  // ---------------------------------------------------------------------------

  async function renderSlideInternal(
    objects: SlideObject[],
    background?: SlideBackground,
    slideNumber?: number,
  ): Promise<string> {
    // Set the page-number context so any text leaf flagged
    // `isSlideNumber` rasterises with this slide's value. Cleared
    // before any await — concurrent thumbnail renders are serialised
    // through `renderQueue`, so we never have two slides racing for the
    // global, but we still defensively reset on each call.
    setRenderingSlideNumber(slideNumber)
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
    //      BEFORE the one-shot `extract.base64()` below. Otherwise the
    //      PNG we capture has the background container empty.
    //
    // The thumbnail renderer doesn't share a ResourceManager with the
    // main canvas (textures here are tied to this offscreen Pixi app's
    // lifetime — destroyed alongside `app`), so the acquire/release
    // hooks stay unset and `mountImageBackground` falls through to its
    // direct `Image.decode() + Texture.from(img)` path.
    // Collect async work that must finish before the one-shot extract.base64
    // below: image-background decode + each object renderer's thumbnailMount
    // ready promise. Declared above the bg block so the bg's promise can
    // be pushed alongside the per-object ones.
    const readyPromises: Promise<unknown>[] = []

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
      })
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
    // P12g: remember which renderer mounted each child so the destroy
    // pass below can route through `renderer.destroy()` instead of
    // Pixi's generic `Container.destroy({ children: true })`. Without
    // it, image / video child containers leaked their acquired
    // ResourceManager textures every render — the registered
    // releasePosterTexture / releaseTexture hooks never fired.
    const mounted: Array<{ node: Container; type: string }> = []
    for (const obj of objects) {
      const renderer = getRenderer(obj.type)
      if (renderer === undefined) {
        // Unknown type — silently skip (same policy as SceneGraph.addObject).
        continue
      }
      const mountFn = renderer.thumbnailMount ?? renderer.mount
      const node = mountFn.call(renderer, obj)
      slideContainer.addChild(node)
      mounted.push({ node, type: obj.type })
      const ready = getThumbnailReady(node)
      if (ready !== undefined) readyPromises.push(ready)
    }

    // Await all async mounts (image decode, video-info fetch). Each ready-
    // promise is already wrapped in its own try/catch inside thumbnailMount,
    // so a single failed asset does not reject the whole render.
    if (readyPromises.length > 0) {
      await Promise.allSettled(readyPromises)
    }

    // The app may have been destroyed during the await above (e.g. the
    // user navigated to present mode while thumbnails were still being
    // rendered). Abort instead of touching a torn-down renderer.
    if (destroyed || app.renderer === null) {
      slideContainer.destroy({ children: true })
      throw new Error('[ThumbnailRenderer] renderer has been destroyed')
    }

    // P5c: DropShadowFilter + BlurFilter crash the offscreen thumbnail
    // renderer (BindGroup.setResource null deref). Strip every filter from
    // the subtree before rendering — thumbnails accept the loss of shadow
    // and blur in exchange for a render that actually succeeds.
    stripFilterEffectsTree(slideContainer)

    app.stage.addChild(slideContainer)

    // Render one frame synchronously — the offscreen app is not running a ticker.
    // Wrap in try/catch because Pixi v8's HTMLTextPipe occasionally throws
    // `_getFinalPadding of null` when a text node was destroyed mid-batch
    // (we've seen it during SlidesPanel ↔ PresentLayout navigation while
    // background thumbnail renders are in flight). Treat as a recoverable
    // "abandon this thumbnail" condition so the queue keeps moving.
    try {
      app.renderer.render(app.stage)
    } catch (err) {
      if (!slideContainer.destroyed) slideContainer.destroy({ children: true })
      throw new Error(
        `[ThumbnailRenderer] renderer has been destroyed (${err instanceof Error ? err.message : String(err)})`,
      )
    }

    // Pixi v8's HTMLText rasterizes its SVG asynchronously. The first
    // render() above kicks off that work but the Texture is still EMPTY
    // when render returns, so the extracted PNG is missing every text
    // glyph. Walk the subtree, await each HTMLText's texturePromise (set
    // on `_gpuData[renderer.uid]` after the first render dispatch), then
    // render a second frame so the now-loaded glyph textures actually
    // appear in the bitmap we extract.
    const textPromises: Promise<unknown>[] = []
    const rendererUid = app.renderer.uid
    const collectHtmlTextPromises = (c: Container): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (c as any)._gpuData?.[rendererUid]
      const p = gpu?.texturePromise
      if (p && typeof p.then === 'function') textPromises.push(p)
      for (const child of c.children) collectHtmlTextPromises(child as Container)
    }
    collectHtmlTextPromises(slideContainer)
    if (textPromises.length > 0) {
      await Promise.allSettled(textPromises)
      if (destroyed || app.renderer === null) {
        slideContainer.destroy({ children: true })
        throw new Error('[ThumbnailRenderer] renderer has been destroyed')
      }
      // Same defensive try/catch as the first render above.
      try {
        app.renderer.render(app.stage)
      } catch (err) {
        if (!slideContainer.destroyed) slideContainer.destroy({ children: true })
        throw new Error(
          `[ThumbnailRenderer] renderer has been destroyed (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }

    // Extract PNG. Pixi 8.x's extract.base64 returns Promise<string>; the
    // earlier code path treated it as sync and destroyed the source
    // container before the extract finished — first render usually
    // succeeded thanks to the framebuffer still holding pixels, but
    // subsequent renders intermittently produced blank thumbnails or
    // dropped silently when the GPU resources had been freed mid-extract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PixiJS v8 extract API type varies by version
    const dataUrl: string = await (app.renderer as any).extract.base64(slideContainer, 'image/png')

    // The renderer can be destroyed mid-await above (user navigated to
    // present mode or the SlidesPanel unmounted). Pixi nullifies app.stage
    // and app.renderer on destroy; touching them here would throw
    // `Cannot read properties of null (reading 'removeChild')`. Bail out
    // cleanly and let the caller .catch suppress it.
    if (destroyed || app.stage === null || app.renderer === null) {
      if (!slideContainer.destroyed) slideContainer.destroy({ children: true })
      throw new Error('[ThumbnailRenderer] renderer has been destroyed')
    }

    // Cleanup: remove from stage, destroy temp container and all mounted children.
    app.stage.removeChild(slideContainer)

    // P12g: route destroy through the registered renderer for each
    // mounted child so texture / poll / Symbol-tag cleanup actually
    // runs. The previous bare `child.destroy({ children: true })`
    // bypassed videoRenderer.destroy()'s `releasePosterTexture` and
    // imageRenderer.destroy()'s `releaseImageFill`, slowly draining
    // ResourceManager refcounts on every thumbnail re-render.
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
    if (!slideContainer.destroyed) {
      slideContainer.destroy()
    }

    return dataUrl
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    renderSlide(
      objects: SlideObject[],
      background?: SlideBackground,
      slideNumber?: number,
    ): Promise<string> {
      if (destroyed) {
        return Promise.reject(new Error('[ThumbnailRenderer] renderer has been destroyed'))
      }

      // Chain onto the serialisation queue.
      // Each render runs only after the previous one resolves/rejects.
      let resolveRender!: (value: string) => void
      let rejectRender!: (reason: unknown) => void

      const resultPromise = new Promise<string>((resolve, reject) => {
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
            return renderSlideInternal(objects, background, slideNumber).then(
              resolveRender,
              rejectRender,
            )
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
      // Destroy the offscreen Application and all GPU resources it holds.
      app.destroy(true, { children: true, texture: true })
    },
  }
}
