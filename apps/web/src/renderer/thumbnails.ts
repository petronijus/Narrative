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

import { Application, Container } from 'pixi.js'
import { getRenderer } from './objectRenderers/index.js'
import { SLIDE_WIDTH, SLIDE_HEIGHT } from './constants.js'
import type { SlideObject } from '@narrative/shared'

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
   */
  renderSlide(objects: SlideObject[]): Promise<string>

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
  })

  let destroyed = false

  // Serialisation queue — ensures the offscreen canvas is not shared across concurrent renders.
  // Each renderSlide() chains onto this promise so calls execute one-at-a-time.
  let renderQueue: Promise<void> = Promise.resolve()

  // ---------------------------------------------------------------------------
  // Internal render implementation
  // ---------------------------------------------------------------------------

  function renderSlideInternal(objects: SlideObject[]): Promise<string> {
    // Build a temp container that holds the full slide content scaled to thumbnail size.
    const slideContainer = new Container()
    // Scale the entire slide down to thumbnail dimensions.
    slideContainer.scale.set(scale)

    // Mount each object through the registry (same path as the main SceneGraph).
    // Prefer thumbnailMount() when available — it avoids expensive async operations
    // (e.g. texture loads) in the offscreen render path. Full raster image thumbnails
    // are deferred to M29.
    for (const obj of objects) {
      const renderer = getRenderer(obj.type)
      if (renderer === undefined) {
        // Unknown type — silently skip (same policy as SceneGraph.addObject).
        continue
      }
      const mountFn = renderer.thumbnailMount ?? renderer.mount
      const node = mountFn.call(renderer, obj)
      slideContainer.addChild(node)
    }

    app.stage.addChild(slideContainer)

    // Render one frame synchronously — the offscreen app is not running a ticker.
    app.renderer.render(app.stage)

    // Extract PNG from the rendered frame.
    // extract.base64() returns a data URL string synchronously in PixiJS v8.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PixiJS v8 extract API type varies by version
    const dataUrl: string = (app.renderer as any).extract.base64(slideContainer, 'image/png')

    // Cleanup: remove from stage, destroy temp container and all mounted children.
    app.stage.removeChild(slideContainer)

    // Destroy child nodes via their registered renderers to release Pixi resources.
    for (const child of [...slideContainer.children]) {
      // We don't have a direct renderer reference here, so use Pixi's own destroy.
      // Graphics/Text children are self-contained in thumbnail context.
      if (!child.destroyed) {
        child.destroy({ children: true })
      }
    }
    if (!slideContainer.destroyed) {
      slideContainer.destroy()
    }

    return Promise.resolve(dataUrl)
  }

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    renderSlide(objects: SlideObject[]): Promise<string> {
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

      renderQueue = renderQueue.then(() => {
        if (destroyed) {
          rejectRender(new Error('[ThumbnailRenderer] renderer has been destroyed'))
          return
        }
        try {
          return renderSlideInternal(objects).then(resolveRender, rejectRender)
        } catch (err) {
          rejectRender(err)
        }
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
