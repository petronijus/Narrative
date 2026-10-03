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

import type { Application, Container, RenderGroup } from 'pixi.js'

/**
 * Consecutive failed frames after which the scheduler stops retrying on its
 * own. Below it, a failed frame schedules one retry on the next animation
 * frame; at it, the canvas waits for the next real scene change (`markDirty`
 * / `renderNow` from outside), so a renderer that keeps throwing costs at most
 * this many frames (~170 ms at 60 Hz) and never spins in an error loop.
 *
 * Why 10, not 1: a recovery can take several frames. Measured on Pixi's
 * destroyed-batch failure (pixiApplication.ts): the first frame throws on the
 * dead instructions, and each rebuild after it uses up one dead pooled batch
 * before it throws — a slide whose instructions held N batches renders again
 * on frame N + 2.
 */
export const MAX_CONSECUTIVE_RENDER_FAILURES = 10

export class RenderScheduler {
  private app: Application | null
  private rafHandle: number | null = null
  private destroyed = false
  private postRender: Array<() => void> = []
  /** Failed frames since the last one that rendered (0 = healthy). */
  private consecutiveFailures = 0

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
    // Torn down between schedule and fire: Application.destroy() nulls both.
    // Nothing to draw, nothing wrong.
    if ((app.renderer as unknown) == null || (app.stage as unknown) == null) return
    try {
      app.renderer.render(app.stage)
    } catch (err) {
      this.renderFailed(app, err)
      return
    }
    if (this.consecutiveFailures > 0) {
      console.warn(
        `[RenderScheduler] rendering recovered after ${this.consecutiveFailures} failed frame(s)`,
      )
      this.consecutiveFailures = 0
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

  /**
   * A live renderer threw mid-frame. Skip the frame, have Pixi rebuild its
   * instructions, and retry — up to MAX_CONSECUTIVE_RENDER_FAILURES in a row.
   *
   * Pixi abandons a throwing frame half-way, and it replays a render group's
   * instruction set until the scene's structure changes: an instruction set
   * left half-built, or holding objects destroyed under it, fails the same
   * way on every later frame. Until 2026-10 that stopped the canvas for good
   * — one bad frame (Pixi's page-wide pools released under the live canvas,
   * pixiApplication.ts) left it blank until a reload. So every render group
   * is flagged to rebuild from the scene before the retry.
   *
   * Reported twice per streak at most: when it starts and when the retries
   * run out; the frame that renders again ends the streak with a warning.
   */
  private renderFailed(app: Application, err: unknown): void {
    this.consecutiveFailures += 1
    const failures = this.consecutiveFailures
    if (failures === 1) {
      console.error('[RenderScheduler] render failed; skipping the frame and retrying', err)
    }
    rebuildInstructionsOnNextRender(app.stage)
    if (failures < MAX_CONSECUTIVE_RENDER_FAILURES) {
      this.markDirty()
    } else if (failures === MAX_CONSECUTIVE_RENDER_FAILURES) {
      console.error(
        `[RenderScheduler] render failed ${failures} frames in a row; ` +
          'no more retries until the scene changes',
        err,
      )
    }
  }
}

/**
 * Flag every render group under `stage` (the stage's own and the nested
 * ones) to rebuild its instruction set on the next render — what Pixi does
 * itself when a child is added or removed.
 */
function rebuildInstructionsOnNextRender(stage: Container): void {
  // Pixi types it as always set, but a stage gets its render group on its
  // first render, and a torn-down or test-double stage has none.
  const root: RenderGroup | null | undefined = stage.renderGroup
  if (root == null) return
  const pending: RenderGroup[] = [root]
  for (let group = pending.pop(); group !== undefined; group = pending.pop()) {
    group.structureDidChange = true
    pending.push(...group.renderGroupChildren)
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
