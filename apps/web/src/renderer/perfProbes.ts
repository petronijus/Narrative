/**
 * renderer/perfProbes.ts — what the performance harness (apps/web/src/perf/
 * harness.ts, docs/plans/perf-harness.md) needs to touch on the Pixi side.
 * Imported only by the harness, so it lives in the harness's lazily loaded
 * chunk; kept in the renderer because Pixi objects are the renderer's to touch
 * (AGENTS.md → Render = SceneGraph diff only).
 *
 * Nothing here changes what is drawn, except `stripMasks`, a diagnostic the
 * crowded-slide scenario runs on request (PERF_NO_MASK=1) to price the clip
 * masks.
 */

import type { Application, Container } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'
import type { RenderScheduler } from './RenderScheduler.js'
import type { SceneGraph } from './SceneGraph.js'

/** Called after every editor frame: when it started, how long `render` took. */
export type RenderHook = (startedAt: number, ms: number) => void

/**
 * Wrap the editor renderer's `render` so every frame — the scheduler's, a
 * `renderNow`, the ticker's during playback — reports to `hook`. Returns the
 * function that unwraps it.
 */
export function instrumentRender(app: Application, hook: RenderHook): () => void {
  const renderer = app.renderer as unknown as { render: (...args: unknown[]) => unknown }
  const original = renderer.render
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const t = performance.now()
    try {
      return original.apply(this, args)
    } finally {
      hook(t, performance.now() - t)
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
