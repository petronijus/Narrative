/**
 * renderer/perfProbes.ts — what the performance harness (apps/web/src/perf/
 * harness.ts, docs/plans/perf-harness.md) needs to touch on the Pixi side.
 * Imported only by the harness, so it lives in the harness's lazily loaded
 * chunk; kept in the renderer because Pixi objects are the renderer's to touch
 * (AGENTS.md → Render = SceneGraph diff only).
 *
 * Nothing here changes what is drawn, except two diagnostics run on
 * request: `stripMasks` (the crowded-slide scenario, PERF_NO_MASK=1, to
 * price the clip masks) and `setKeepWarmEnabled` (present.spec.ts,
 * PERF_KEEP_WARM_AB=1, to price present mode's keep-warm).
 */

import type { Application, Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'
import type { RenderScheduler } from './RenderScheduler.js'
import type { SceneGraph } from './SceneGraph.js'
import { isKeepWarmFrame, KEEP_WARM_LABEL } from './presentKeepWarm.js'

/**
 * What a `render` drew into: the screen, a slide prepared off stage being
 * drawn into a texture of its own (renderer/presentSlides.ts — not a frame),
 * or the present-mode keep-warm draw (maintenance: not a frame, not work).
 */
export type RenderKind = 'screen' | 'offscreen' | 'keepWarm'

/** Called after every `render` of the editor's renderer: when it started, how long it took, what it drew. */
export type RenderHook = (startedAt: number, ms: number, kind: RenderKind) => void

/**
 * Wrap the editor renderer's `render` so every frame — the scheduler's, a
 * `renderNow`, the ticker's during playback — reports to `hook`. Returns the
 * function that unwraps it.
 */
export function instrumentRender(
  app: Application,
  hook: RenderHook,
  /** Called as a `render` starts, with what it draws into (the harness pauses its GL counts for keep-warm). */
  before?: (kind: RenderKind) => void,
): () => void {
  const renderer = app.renderer as unknown as { render: (...args: unknown[]) => unknown }
  const original = renderer.render
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const t = performance.now()
    const opts = args[0] as { target?: { label?: unknown } | null } | null | undefined
    const target = typeof opts === 'object' && opts !== null ? opts.target : undefined
    const kind: RenderKind =
      target === undefined || target === null
        ? isKeepWarmFrame()
          ? 'keepWarm'
          : 'screen'
        : target.label === KEEP_WARM_LABEL
          ? 'keepWarm'
          : 'offscreen'
    before?.(kind)
    try {
      return original.apply(this, args)
    } finally {
      hook(t, performance.now() - t, kind)
    }
  }
  renderer.render = wrapped
  return () => {
    if (renderer.render === wrapped) renderer.render = original
  }
}

/** The editor's WebGL context, or null on another backend. */
export function editorGl(app: Application): WebGL2RenderingContext | WebGLRenderingContext | null {
  const gl = (app.renderer as unknown as { gl?: unknown }).gl
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    ? gl
    : typeof WebGLRenderingContext !== 'undefined' && gl instanceof WebGLRenderingContext
      ? gl
      : null
}

/** Draw a frame now (the scheduler's synchronous path). */
export function renderNow(scheduler: RenderScheduler): void {
  scheduler.renderNow()
}

/** Ids mounted in the editor scene graph. */
export function mountedIds(sceneGraph: SceneGraph): string[] {
  return sceneGraph.getMountedIds()
}

/** The object as the scene graph last applied it. */
export function objectData(sceneGraph: SceneGraph, id: string): SlideObject | null {
  return sceneGraph.getNode(id)?.data ?? null
}

/** Texts still waiting for the resolution of the last zoom. */
export function pendingTextRestage(sceneGraph: SceneGraph): number {
  return sceneGraph.pendingTextRestage
}

/** Take every mask off the scene (a diagnostic: what do the clip masks cost?). Returns how many. */
export function stripMasks(sceneGraph: SceneGraph): number {
  let n = 0
  const walk = (c: Container): void => {
    if (c.mask) {
      const mask = c.mask as Container
      mask.visible = false
      c.mask = null
      n++
    }
    for (const ch of c.children) walk(ch as Container)
  }
  walk(sceneGraph.getRoot())
  return n
}

/** Switch present mode's keep-warm on or off (a diagnostic: what does an advance cost without it?). */
export {
  setKeepWarmEnabled,
  setKeepWarmFrame,
  setKeepWarmTarget,
  setPresentIdleFallback,
  type KeepWarmFrame,
  type KeepWarmTarget,
  type PresentIdleFallback,
} from './presentKeepWarm.js'

/** Thumbnails waiting or rendering (the store's queues, debounces and retries): settle waits for 0. */
export { pendingThumbnailWork } from './thumbnailStore.js'
