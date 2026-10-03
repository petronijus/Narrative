/**
 * renderer/pixiApplication.ts
 *
 * The one way a Pixi Application in this page is torn down.
 *
 * Pixi v8 keeps module-global pools that every Application in the page
 * shares: the draw-batch pool (`Batcher`), `TexturePool`, `CanvasPool`, the
 * object `PoolGroup` and the canvas-texture cache. `renderer.destroy(true)` —
 * what `app.destroy(true, …)` passes down — also calls
 * `GlobalResourceRegistry.release()`, which empties all of them for the whole
 * page. The batch pool does not forget a batch it hands out (`getBatchFromPool`
 * leaves the slot's reference in place), so the release destroys batches that
 * another, live renderer is still drawing with. That renderer's next frame
 * throws `Cannot read properties of null (reading 'geometry')` in
 * `BatcherPipe.execute` (or `'clear'` in `Batcher.break` when it rebuilds) and
 * keeps throwing: the canvas stops painting for good. Which renderer dies
 * depends on who used the pool last; a thumbnail renderer dies silently.
 *
 * Applications with overlapping lifetimes are normal here: the editor or
 * present canvas, the SlidesPanel / presenter thumbnail renderer, the one-shot
 * thumbnail renderer of promote-to-component, and in dev (React StrictMode)
 * the first, cancelled Canvas mount, whose `init()` can resolve after the
 * second mount has already painted — that one is what broke
 * `folder-tokens.spec.ts` under load.
 *
 * So the global resources are never released, not even when the last
 * Application goes: module-level caches in this layer hold textures across
 * Applications (fill and background textures, the canvas-texture cache), and
 * a release would destroy those under the next canvas. The pools are bounded
 * by peak use and are reused by the next Application; the GPU objects behind
 * them belong to each renderer's own GL context and go with it.
 *
 * Never call `Application.destroy(true, …)` or `renderer.destroy(true)`
 * directly; call this. Regression: `renderer-visual.spec.ts` → "tearing down
 * another Pixi application leaves the editor canvas painting".
 */

import type { Application } from 'pixi.js'

/**
 * Destroy `app`: remove its canvas from the DOM, destroy its stage with every
 * child and their textures, and destroy the renderer — without releasing the
 * page-wide Pixi pools other Applications are using.
 */
export function destroyPixiApplication(app: Application): void {
  app.destroy(
    { removeView: true, releaseGlobalResources: false },
    { children: true, texture: true },
  )
}
