/**
 * renderer/RenderScheduler.ts
 *
 * P12b — idle GPU fix.
 *
 * Pixi v8 default behaviour: `app.init()` starts a rAF loop that calls
 * `app.renderer.render(app.stage)` 60 times a second forever, regardless
 * of whether anything in the scene changed. On a passive editor that pegs
 * the GPU at ~30 % usage and burns laptop battery for nothing.
 *
 * This module flips the model:
 *
 *   1. `Canvas.tsx` initialises Pixi with `autoStart: false` so the
 *      built-in render loop never starts.
 *   2. Every site that mutates the Pixi scene (SceneGraph, OverlayCompositor,
 *      ArtboardBackground, animation runtime) calls `scheduler.markDirty()`.
 *   3. `markDirty()` schedules a single rAF that performs exactly one
 *      `app.renderer.render(app.stage)` and clears the dirty flag.
 *
 * During timeline playback the consumers also call `app.ticker.start()` so
 * GSAP-driven property changes get rendered every frame at full speed; on
 * pause/end they call `app.ticker.stop()` and the scheduler takes over
 * again.
 *
 * The scheduler is exposed both:
 *   - as a singleton via `setDefaultRenderScheduler` for modules that
 *     can't easily receive it as a parameter (renderers triggered from
 *     deep call paths), and
 *   - by injection into `SceneGraph` / `OverlayCompositor` / animation
 *     runtime where the data flow already passes through.
 */

import type { Application } from 'pixi.js'

export class RenderScheduler {
  private app: Application | null
  private rafHandle: number | null = null
  private destroyed = false
  private postRender: Array<() => void> = []

  constructor(app: Application) {
    this.app = app
  }

  /**
   * Schedule a single render on the next animation frame. Multiple calls
   * within the same frame coalesce into one render.
   */
  markDirty(): void {
    if (this.destroyed) return
    if (this.rafHandle !== null) return
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null
      this.runRender()
    })
  }

  /**
   * Force a synchronous render right now. Use sparingly — preferred path
   * is `markDirty()`. Useful for the first paint after Pixi init and for
   * cases where the caller needs the new pixels immediately (e.g.
   * thumbnails tied to the main app).
   */
  renderNow(): void {
    if (this.destroyed) return
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    this.runRender()
  }

  /**
   * Subscribe a callback that runs after each scheduler-driven render.
   * Replaces the per-tick listener that OverlayCompositor used to install
   * on the Pixi ticker — under autoStart:false the ticker rarely fires,
   * so overlays piggyback on the scheduler's own frames instead.
   */
  onAfterRender(fn: () => void): () => void {
    this.postRender.push(fn)
    return () => {
      const i = this.postRender.indexOf(fn)
      if (i >= 0) this.postRender.splice(i, 1)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.app = null
    this.postRender = []
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  private runRender(): void {
    const app = this.app
    if (this.destroyed || app === null) return
    try {
      app.renderer.render(app.stage)
    } catch {
      // Renderer was torn down between schedule and fire. Safe to drop.
      return
    }
    // Snapshot subscribers so an unsubscribe inside a callback can't
    // skip the next entry in the same render pass.
    const subs = this.postRender.slice()
    for (const fn of subs) {
      try {
        fn()
      } catch (err) {
        console.error('[RenderScheduler] onAfterRender subscriber threw', err)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton — used by deep callers that can't receive the scheduler
// as a parameter (e.g. renderers triggered from inside applyPatch).
// ---------------------------------------------------------------------------

let defaultScheduler: RenderScheduler | null = null

export function setDefaultRenderScheduler(scheduler: RenderScheduler | null): void {
  defaultScheduler = scheduler
}

export function getDefaultRenderScheduler(): RenderScheduler | null {
  return defaultScheduler
}

/**
 * Convenience: mark the default scheduler dirty if one is installed.
 * No-op when no scheduler is set (tests, headless contexts).
 */
export function markRenderDirty(): void {
  defaultScheduler?.markDirty()
}
