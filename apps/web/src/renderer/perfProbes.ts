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

import { TexturePool } from 'pixi.js'
import type { Application, Container, Texture } from 'pixi.js'
import type { SlideObject } from '@narrative/shared'
import type { RenderScheduler } from './RenderScheduler.js'
import type { SceneGraph } from './SceneGraph.js'
import { isKeepWarmFrame, KEEP_WARM_LABEL } from './presentKeepWarm.js'
import { textureSourceBytes } from './ResourceManager.js'
import { drawnRegionOf } from './runText/placement.js'
import { runTextureMemory } from './runText/runTextSystem.js'

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
  setPresentIdleFallback,
  type KeepWarmFrame,
  type PresentIdleFallback,
} from './presentKeepWarm.js'

/** Thumbnails waiting or rendering (the store's queues, debounces and retries): settle waits for 0. */
export { pendingThumbnailWork } from './thumbnailStore.js'

/** What the canvas's text rasters hold on the GPU, and what Pixi's texture pool keeps idle (textTextureMemory). */
export interface TextTextureMemory {
  /** The editor canvas's run-text textures (runText/runTextSystem.ts → runTextureMemory). */
  run: {
    count: number
    /** Pixels of the rasters themselves. */
    rasterPx: number
    /** Pixels of the textures holding them (≥ rasterPx: a texture may be larger than its raster). */
    texturePx: number
    /** Textures with a mipmap chain. */
    mipmapped: number
    /** Their GPU bytes (4 a pixel, a third more with mipmaps). */
    bytes: number
    /** The texts whose box meets the canvas's drawn region (ADR 0020), and their rasters' pixels. */
    inRegion: number
    inRegionRasterPx: number
    /** Of those pixels, the ones of the part of each text inside the region (world area × resolution²). */
    inRegionShownPx: number
    /** The largest resolution a live raster has, and the renderer's. */
    maxResolution: number
    rendererResolution: number
  }
  /** The thumbnails' run-text textures. */
  thumb: { count: number; rasterPx: number; texturePx: number; bytes: number }
  /**
   * Pixi's `TexturePool` (shared by every renderer of the page): textures
   * returned and waiting for reuse, and those of them still holding a GPU
   * texture in the editor's context (Pixi's collector frees one a minute
   * after its last use, and only after a render).
   */
  pool: {
    idle: number
    idlePx: number
    resident: number
    residentPx: number
    residentBytes: number
  }
}

/** The idle textures of Pixi's pool (its buckets are private: read, never changed). */
function pooledTextures(): Texture[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TexturePool's buckets are private
  const buckets = (TexturePool as any)._buckets as Map<number, Texture[]> | undefined
  const out: Texture[] = []
  if (buckets !== undefined) for (const list of buckets.values()) out.push(...list)
  return out
}

/** What the editor's text rasters and Pixi's texture pool hold now (the perf harness: `textureMemory`). */
export function textTextureMemory(app: Application): TextTextureMemory {
  const renderer = app.renderer as unknown as { uid: number; resolution: number }
  const run = runTextureMemory('text')
  const region = drawnRegionOf(app.renderer)
  let inRegion = 0
  let inRegionRasterPx = 0
  let inRegionShownPx = 0
  let maxResolution = 0
  for (const t of run.textures) {
    maxResolution = Math.max(maxResolution, t.resolution)
    const text = t.text
    if (text === null || text.destroyed) continue
    const b = text.getBounds()
    const meets =
      region === null ||
      (b.x < region.x + region.width &&
        b.x + b.width > region.x &&
        b.y < region.y + region.height &&
        b.y + b.height > region.y)
    if (meets) {
      inRegion++
      inRegionRasterPx += t.raster.width * t.raster.height
      if (region !== null) {
        const w = Math.min(b.x + b.width, region.x + region.width) - Math.max(b.x, region.x)
        const h = Math.min(b.y + b.height, region.y + region.height) - Math.max(b.y, region.y)
        inRegionShownPx += Math.max(0, w) * Math.max(0, h) * t.resolution ** 2
      } else inRegionShownPx += t.raster.width * t.raster.height
    }
  }
  const thumb = runTextureMemory('thumb.text')
  let idlePx = 0
  let resident = 0
  let residentPx = 0
  let residentBytes = 0
  const idle = pooledTextures()
  for (const texture of idle) {
    const source = texture.source
    const px = source.pixelWidth * source.pixelHeight
    idlePx += px
    const gpu = (source as unknown as { _gpuData?: Record<number, unknown> })._gpuData
    if (gpu?.[renderer.uid] !== undefined) {
      resident++
      residentPx += px
      residentBytes += textureSourceBytes(source)
    }
  }
  return {
    run: {
      count: run.count,
      rasterPx: run.rasterPx,
      texturePx: run.texturePx,
      mipmapped: run.mipmapped,
      bytes: run.bytes,
      inRegion,
      inRegionRasterPx,
      inRegionShownPx,
      maxResolution,
      rendererResolution: renderer.resolution,
    },
    thumb: {
      count: thumb.count,
      rasterPx: thumb.rasterPx,
      texturePx: thumb.texturePx,
      bytes: thumb.bytes,
    },
    pool: { idle: idle.length, idlePx, resident, residentPx, residentBytes },
  }
}
