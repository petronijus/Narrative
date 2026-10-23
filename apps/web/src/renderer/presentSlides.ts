/**
 * renderer/presentSlides.ts — slides prepared ahead for present mode
 * (docs/plans/performance.md → D, P1/P2; ADR 0016).
 *
 * Present mode shows a slide by swapping a scene in, never by mounting it:
 * each slide of the plan is built off stage — its background and every
 * object mounted through the renderer registry, exactly as the scene graph
 * mounts them — then drawn once into a 1 × 1 render texture, which makes
 * Pixi upload every picture and start every text raster; once the rasters
 * have landed (and been uploaded: Pixi uploads an HTMLText raster as it
 * lands) it is drawn once more, so nothing about the scene is left for the
 * frame that shows it. `SceneGraph.swapSlideScene` then puts it on stage in
 * one frame, and the slide it replaces comes back here intact: an advance,
 * a step back and a jump only composite.
 *
 * What a prepared scene is a picture of — its version — is compared before
 * it is shown: the deck store's objects array (its identity changes with any
 * edit of the slide's objects, text included), the background, the page
 * number, the surface its colour tokens resolve on, the token colours
 * themselves and the faces of the fonts installed. A scene that no longer
 * matches is rebuilt; one shown on stage is the scene graph's to update.
 *
 * GPU memory is the ResourceManager's to budget (`admitResident`): the plan
 * lists slides by priority (the slide shown, the next, the previous, the
 * slides linked from the one shown, then further ahead), the slides the
 * presenter can reach in one step are resident whatever the budget says, and
 * the rest only as long as the union of their textures fits; lower priorities
 * make room for higher ones. Pixi's garbage collector is off on the present
 * canvas (Canvas.tsx `gc`), so nothing prepared is unloaded behind this.
 *
 * Before the presentation is ready the plan is built as fast as it goes;
 * after, a slide entering the plan (a big deck's window moving on) is built
 * in idle time only, never while a transition or a build animation runs.
 * Either way its pictures reach the GPU through the ResourceManager's upload
 * gate (textureUploadGate.ts): a bounded number of pixels per frame — the
 * preparing overlay keeps its frames — and none while the presentation
 * moves (`setBusyProbe` holds it). A picture counts as loaded only once it
 * is uploaded (renderWork.ts), so the warm-up draws below find every
 * picture on the GPU already and ready waits for the last of them.
 *
 * Kept warm: what a frame needs on the GPU goes cold while nothing is drawn
 * — measured on an M3 Pro under memory pressure (ANGLE Metal, 2026-10-19,
 * e2e/perf diagnostics): the canvas that presented nothing for 5–20 s cost
 * its next frame of the same slide 25–113 ms (11–15 ms right after), and a
 * swap after 5 s 100–113 ms (a 100 ms frame), all of it in the GPU
 * process's command execution, with 0.2 ms of `render` on the main thread
 * and nothing uploaded. Drawing the textures again or presenting a frame
 * again each fixed only half of it: with both, the swap after 5 s took
 * 12–20 ms and no frame was missed. So while the presentation rests, every
 * `KEEP_WARM_MS` (an idle turn — an idle callback, or where the engine has
 * none, right after the next rendered frame: presentKeepWarm.ts →
 * whenPresentIdle; never during a transition, a build or on a hidden page)
 * the slide shown and the slides one step away are drawn into a 1 × 1 target
 * of their own, and the canvas presents a frame of what it shows (unless
 * Pixi's ticker is presenting frames anyway).
 */

import {
  Container,
  Graphics,
  Matrix,
  RenderTexture,
  Sprite,
  Texture,
  type TextureSource,
} from 'pixi.js'
import type { ColourResolverFn } from './colourResolver.js'
import type { ImageVariant, Slide, SlideObject } from '@narrative/shared'
import { DEFAULT_BACKGROUND, perfCount, perfCountFor } from '@narrative/shared'
import { applyBackground } from './ArtboardBackground.js'
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './constants.js'
import {
  getColourResolver,
  subscribeColourResolver,
  tokenColourSignature,
  withRenderingSurface,
} from './colourResolver.js'
import { fontFamilyVersions, subscribeFontFamilyChanges } from './fontChanges.js'
import { fontSignature, serialiseThumbnailInputs } from './thumbnailKey.js'
import { collectHtmlTextRasters } from './htmlTextRaster.js'
import { getDefaultImageUrlResolver } from './imageUrl.js'
import { withPixelDensity } from './pixelDensityContext.js'
import { scaledUpObjectIds } from './imageVariant.js'
import { getRenderer } from './objectRenderers/index.js'
import { attachLiveVideo } from './objectRenderers/videoRenderer.js'
import { pendingRenderWork, whenRenderWorkIdle } from './renderWork.js'
import { getDefaultResourceManager, type ResourceManager } from './ResourceManager.js'
import { outsideFadeAlpha, type SceneGraph, type SlideScene } from './SceneGraph.js'
import {
  asKeepWarmFrame,
  KEEP_WARM_LABEL,
  KEEP_WARM_MS,
  keepWarmEnabled,
  keepWarmFrame,
  keepWarmTarget,
  type KeepWarmTarget,
  whenPresentIdle,
} from './presentKeepWarm.js'
import { getDefaultRenderScheduler } from './RenderScheduler.js'
import { getRenderingSlideNumber, setRenderingSlideNumber } from './slideNumberContext.js'

/** One slide of the plan and what its picture depends on besides its objects. */
export interface PresentSlideSpec {
  slide: Slide
  /** The page number its page-number fields show (deck order, skipped slides not counted). */
  slideNumber: number | undefined
  /** The surface its colour tokens resolve on (its layout's). */
  surface: string | undefined
}

/** The transform a build or a transition may change, kept to put the scene back as it was built. */
interface Baseline {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotation: number
  alpha: number
}

/** A slide scene this cache built, with what it needs to check and restore it. */
export interface PreparedSlide extends SlideScene {
  spec: PresentSlideSpec
  /** What the slide's token colours resolve to (colourResolver.tokenColourSignature). */
  tokenSignature: string
  /** Its objects serialised (thumbnailKey.serialiseThumbnailInputs): what its font families are read from. */
  serialised: string
  /** The faces of its families when it was built (fontSignatureOf). */
  fontSignature: string
  baselines: Map<Container, Baseline>
  /** Its texture sources (what admitResident counts). */
  sources: Set<TextureSource>
}

interface Entry {
  spec: PresentSlideSpec
  prepared: PreparedSlide | null
  /** Built for a resolver, a face set or a version that has changed since. */
  stale: boolean
}

export interface PresentSlideCacheOptions {
  sceneGraph: SceneGraph
  resourceManager: ResourceManager
  /** How long a scene's loads and rasters are waited for before it is kept as it is (ms). */
  settleTimeoutMs?: number
  /**
   * The buffered element of a video object (renderer/presentVideos.ts), so a
   * scene with that video draws its live first frame from the start.
   */
  liveVideo?: (objectId: string) => HTMLVideoElement | null
}

/** Loads and rasters of one scene: given up on (and the scene kept as drawn) after this long. */
const SETTLE_TIMEOUT_MS = 20_000

/**
 * The faces a slide's text was drawn with, as a signature: the families its
 * objects name, each with the version of its faces (renderer/fontChanges.ts,
 * as a thumbnail key has it). A face of one of them installed or removed
 * since moves it; a face of a family the slide does not use does not.
 */
function fontSignatureOf(serialised: string): string {
  return fontSignature(serialised, fontFamilyVersions())
}

const sameBackground = (a: Slide['background'], b: Slide['background']): boolean =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Whether a scene built for `built` shows what `wanted` asks for (objects, background, page number, surface). */
function sameVersion(built: PresentSlideSpec, wanted: PresentSlideSpec): boolean {
  return (
    built.slide.id === wanted.slide.id &&
    built.slide.objects === wanted.slide.objects &&
    sameBackground(built.slide.background, wanted.slide.background) &&
    built.slideNumber === wanted.slideNumber &&
    built.surface === wanted.surface
  )
}

function takeBaseline(c: Container): Baseline {
  return {
    x: c.x,
    y: c.y,
    scaleX: c.scale.x,
    scaleY: c.scale.y,
    rotation: c.rotation,
    alpha: c.alpha,
  }
}

function putBaseline(c: Container, b: Baseline): void {
  if (c.destroyed) return
  c.position.set(b.x, b.y)
  c.scale.set(b.scaleX, b.scaleY)
  c.rotation = b.rotation
  c.alpha = b.alpha
}

/** The texture sources a scene draws: pictures, text rasters, gradient and image fills. */
function collectSources(root: Container, rendererUid: number): Set<TextureSource> {
  const out = new Set<TextureSource>()
  const add = (t: Texture | undefined | null): void => {
    const source = t?.source
    if (source === undefined || source === null) return
    if (t === Texture.EMPTY || t === Texture.WHITE) return
    out.add(source)
  }
  const walk = (c: Container): void => {
    if (c instanceof Sprite) add(c.texture)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pixi keeps per-renderer GPU data untyped
    const gpu = (c as any)._gpuData?.[rendererUid]
    // An HTMLText's raster (its texture per renderer, once it has landed).
    if (gpu?.texture?.source !== undefined) add(gpu.texture as Texture)
    if (c instanceof Graphics) {
      for (const instruction of c.context?.instructions ?? []) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fill / stroke / texture instructions differ in shape
        const data = instruction.data as any
        add(data?.style?.texture)
        add(data?.image)
      }
    }
    for (const child of c.children) walk(child as Container)
  }
  walk(root)
  return out
}

/** Destroy a scene taken off the stage or never shown: every node through its renderer, then the root. */
export function destroySlideScene(scene: SlideScene): void {
  for (const node of scene.nodes) {
    if (node.container.destroyed) continue
    try {
      getRenderer(node.data.type)?.destroy(node.container)
    } catch (err) {
      console.error('[presentSlides] renderer.destroy threw', err)
    }
  }
  if (scene.background !== null && !scene.background.destroyed) {
    // Clearing it releases what it holds (an image background's texture, a gradient's).
    let rm: ResourceManager | null = null
    try {
      rm = getDefaultResourceManager()
    } catch {
      rm = null
    }
    void applyBackground({
      container: scene.background,
      background: undefined,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      ...(rm !== null ? { releaseTexture: (url: string) => rm.releaseTexture(url) } : {}),
    })
  }
  if (!scene.root.destroyed) {
    scene.root.parent?.removeChild(scene.root)
    try {
      scene.root.destroy({ children: true })
    } catch (err) {
      // Leaving present mode can destroy the canvas's renderer first (its
      // effect cleans up before the cache's): the scene's GPU side went with it.
      console.warn('[presentSlides] destroying a scene after its renderer', err)
    }
  }
}

/**
 * The slides of a presentation, prepared ahead (see the module comment).
 * One per present canvas; `destroy()` when it goes.
 */
export class PresentSlideCache {
  private readonly sceneGraph: SceneGraph
  private readonly rm: ResourceManager
  private readonly settleTimeoutMs: number
  private readonly liveVideo: (objectId: string) => HTMLVideoElement | null
  private plan: PresentSlideSpec[] = []
  /** Slides resident whatever the budget: the one shown and those one step away. */
  private required = new Set<string>()
  private readonly entries = new Map<string, Entry>()
  /** Scenes this cache built, by root — `give` takes back only its own. */
  private readonly built = new WeakMap<Container, PreparedSlide>()
  /** Slides taken (`take`) and on stage now, by their root: not built again while there. */
  private readonly onStage = new Map<string, Container>()
  private building: string | null = null
  /** After ready: build in idle time only. */
  private idleOnly = false
  /** Whether a transition or a build animation runs now: nothing is built while it does. */
  private busy: () => boolean = () => false
  /** The budget refused a slide of this plan: nothing of lower priority is built until the plan changes. */
  private budgetFull = false
  /** The plan's slide ids and required ids, as setPlan last had them. */
  private planOrder = ''
  private readonly listeners = new Set<() => void>()
  private warmTarget: RenderTexture | null = null
  private keepWarmTarget: RenderTexture | null = null
  /** What `keepWarmTarget` was made for (presentKeepWarm.ts → KeepWarmTarget) and at which resolution. */
  private keepWarmTargetOf = ''
  /** The pending keep-warm turn (a timer, then an idle callback): cancels it. */
  private keepWarmCancel: (() => void) | null = null
  private destroyed = false
  /**
   * The variant each picture of the deck is drawn from on every slide: the
   * largest any slide needs (present/preloadMedia.ts). Every prepared slide
   * stays on the GPU, so a photo shown full-bleed on one slide and small on
   * another is one texture, not two.
   */
  private variantFloor: ReadonlyMap<string, ImageVariant> = new Map()
  private readonly unsubscribeColours: () => void
  private readonly unsubscribeFonts: () => void

  constructor(opts: PresentSlideCacheOptions) {
    this.sceneGraph = opts.sceneGraph
    this.rm = opts.resourceManager
    this.settleTimeoutMs = opts.settleTimeoutMs ?? SETTLE_TIMEOUT_MS
    this.liveVideo = opts.liveVideo ?? (() => null)
    // Token colours changed: a scene whose slide resolves them differently now is stale.
    this.unsubscribeColours = subscribeColourResolver(() => {
      let changed = false
      for (const e of this.entries.values()) {
        const p = e.prepared
        if (p === null || e.stale) continue
        if (tokenColourSignature(p.spec.slide.objects, p.spec.surface) !== p.tokenSignature) {
          e.stale = true
          changed = true
        }
      }
      if (changed) this.pump()
    })
    // A face installed or removed: the scenes whose text names its family
    // were drawn without it (the versions move before listeners are told).
    this.unsubscribeFonts = subscribeFontFamilyChanges(() => {
      let changed = false
      for (const e of this.entries.values()) {
        const p = e.prepared
        if (p !== null && !e.stale && fontSignatureOf(p.serialised) !== p.fontSignature) {
          e.stale = true
          changed = true
        }
      }
      if (changed) this.pump()
    })
  }

  /**
   * The slides to keep prepared, by priority, and the ones resident
   * whatever the budget. Scenes of slides no longer planned are destroyed;
   * a planned slide whose version moved is rebuilt.
   */
  setPlan(plan: readonly PresentSlideSpec[], required: readonly string[]): void {
    if (this.destroyed) return
    // A full budget stays full for the same priorities: building the next
    // slide again would only throw it away again. A window that moved may
    // make room (lower priorities give way), so it tries again.
    const order = plan.map((s) => s.slide.id).join('\n') + '\n\n' + required.join('\n')
    if (order !== this.planOrder) this.budgetFull = false
    this.planOrder = order
    this.plan = [...plan]
    this.required = new Set(required)
    const planned = new Set(plan.map((s) => s.slide.id))
    for (const [id, e] of [...this.entries]) {
      if (!planned.has(id) && this.building !== id) this.evict(id)
      else {
        const spec = plan.find((s) => s.slide.id === id)
        if (spec !== undefined && !sameVersion(e.spec, spec)) e.stale = true
      }
    }
    this.pump()
    this.notify()
  }

  /** After ready: build only in idle time (`true`), or as fast as possible. */
  setIdleOnly(on: boolean): void {
    this.idleOnly = on
    // Ready: from now on the slides around the presenter are kept warm.
    if (on) this.scheduleKeepWarm()
    else this.stopKeepWarm()
  }

  /** Tell the cache when the presentation is moving (a transition, a build): it builds nothing then. */
  setBusyProbe(probe: () => boolean): void {
    this.busy = probe
    // A picture of a slide built in idle time waits in the upload gate
    // (textureUploadGate.ts) while the presentation moves, too.
    this.rm.setUploadHold(probe)
  }

  /** Whether `slideId` can be shown now: built for its current version and fresh. */
  isReady(slideId: string): boolean {
    const e = this.entries.get(slideId)
    if (e === undefined || e.prepared === null || e.stale) return false
    const spec = this.plan.find((s) => s.slide.id === slideId)
    return spec !== undefined && sameVersion(e.prepared.spec, spec)
  }

  /** How much of the plan is prepared (for the preparing overlay). */
  progress(): { prepared: number; planned: number; done: boolean } {
    let prepared = 0
    for (const spec of this.plan) if (this.isReady(spec.slide.id)) prepared++
    return { prepared, planned: this.plan.length, done: this.settledPlan() }
  }

  /**
   * Whether there is nothing left to build: every planned slide ready, or
   * the budget full and every required one ready.
   */
  settledPlan(): boolean {
    if (this.building !== null) return false
    return this.nextToBuild() === null
  }

  /** Resolves once `slideIds` are all ready (rejects never; ends when the cache is destroyed). */
  whenReady(slideIds: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      const check = (): boolean => {
        if (this.destroyed || slideIds.every((id) => this.isReady(id))) {
          this.listeners.delete(onChange)
          resolve()
          return true
        }
        return false
      }
      const onChange = (): void => {
        check()
      }
      if (!check()) this.listeners.add(onChange)
    })
  }

  /** Be told whenever a slide became ready or the plan changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Hand the prepared scene of `slideId` over to be shown (it leaves the
   * cache: the scene graph holds it from now on), or null when it is not ready.
   */
  take(slideId: string): PreparedSlide | null {
    if (!this.isReady(slideId)) return null
    const e = this.entries.get(slideId)!
    const prepared = e.prepared!
    this.entries.delete(slideId)
    this.onStage.set(slideId, prepared.root)
    // Still resident — on stage — under its key until it comes back or goes.
    this.notify()
    return prepared
  }

  /**
   * The scene a swap took off the stage (SceneGraph.swapSlideScene). One
   * this cache built, unedited since and still planned at its version, is
   * put back as it was built (a build animation or a transition moved its
   * containers) and kept; anything else is destroyed.
   */
  give(scene: SlideScene): void {
    if (this.onStage.get(scene.slideId) === scene.root) this.onStage.delete(scene.slideId)
    const prepared = this.built.get(scene.root)
    const spec = this.plan.find((s) => s.slide.id === scene.slideId)
    // Why a scene goes instead of staying (counted: a scene destroyed on the
    // way back is a slide built again later).
    const reason = this.destroyed
      ? 'destroyed'
      : prepared === undefined
        ? 'foreign'
        : scene.objects === null
          ? 'edited'
          : scene.objects !== prepared.spec.slide.objects
            ? 'version'
            : spec === undefined
              ? 'unplanned'
              : !sameVersion(prepared.spec, spec)
                ? 'version'
                : this.entries.has(scene.slideId)
                  ? 'duplicate'
                  : fontSignatureOf(prepared.serialised) !== prepared.fontSignature
                    ? 'fonts'
                    : tokenColourSignature(prepared.spec.slide.objects, prepared.spec.surface) !==
                        prepared.tokenSignature
                      ? 'colours'
                      : null
    if (reason !== null || prepared === undefined) {
      perfCountFor('present.give.dropped', reason ?? 'foreign')
      if (prepared !== undefined) this.rm.releaseResident(scene.slideId)
      destroySlideScene(scene)
      this.pump()
      return
    }
    // The nodes as the scene graph last had them (their data snapshots).
    prepared.nodes = scene.nodes
    prepared.paintedWith = scene.paintedWith
    for (const [c, b] of prepared.baselines) putBaseline(c, b)
    this.entries.set(scene.slideId, { spec: prepared.spec, prepared, stale: false })
    this.notify()
    this.pump()
  }

  /**
   * Draw a kept scene into the warm target once more — after something it
   * shows changed off stage (a video rewound to its first frame) — so its
   * next frame on stage uploads nothing.
   */
  rewarm(slideId: string): void {
    const p = this.entries.get(slideId)?.prepared
    if (p === null || p === undefined) return
    this.warm(p.root)
  }

  /** `rewarm`, in idle time, every kept scene that shows object `objectId` (a video put back on its first frame). */
  rewarmContaining(objectId: string): void {
    for (const [slideId, e] of this.entries) {
      if (e.prepared === null || !e.prepared.nodes.some((n) => n.id === objectId)) continue
      void this.turn().then(() => {
        if (!this.destroyed) this.rewarm(slideId)
      })
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribeColours()
    this.unsubscribeFonts()
    this.stopKeepWarm()
    this.rm.setUploadHold(null)
    for (const id of [...this.entries.keys()]) this.evict(id)
    for (const target of [this.warmTarget, this.keepWarmTarget])
      try {
        target?.destroy(true)
      } catch {
        // The renderer went first (see destroySlideScene).
      }
    this.warmTarget = null
    this.keepWarmTarget = null
    this.notify()
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------

  private notify(): void {
    for (const l of [...this.listeners]) l()
  }

  private evict(slideId: string): void {
    const e = this.entries.get(slideId)
    this.entries.delete(slideId)
    if (e?.prepared != null) {
      this.rm.releaseResident(slideId)
      destroySlideScene(e.prepared)
      perfCount('present.prepare.evicted')
    }
  }

  /** The first planned slide not ready, unless the budget is full and it is not required. */
  private nextToBuild(): PresentSlideSpec | null {
    for (const spec of this.plan) {
      if (this.isReady(spec.slide.id) || this.onStage.has(spec.slide.id)) continue
      if (this.budgetFull && !this.required.has(spec.slide.id)) continue
      return spec
    }
    return null
  }

  private pump(): void {
    if (this.destroyed || this.building !== null) return
    const spec = this.nextToBuild()
    if (spec === null) {
      this.notify()
      return
    }
    this.building = spec.slide.id
    void this.build(spec)
      .catch((err: unknown) => console.error('[presentSlides] building a slide failed', err))
      .finally(() => {
        this.building = null
        this.notify()
        this.pump()
      })
  }

  /**
   * Wait for a moment the presentation can spare: before ready, now; after
   * ready, an idle callback while no transition or build animation runs.
   */
  private async turn(): Promise<void> {
    if (!this.idleOnly) return
    for (;;) {
      if (this.destroyed) return
      await new Promise<void>((resolve) => whenPresentIdle(resolve, 2000))
      if (!this.busy()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Draw the slide on stage and the prepared slides the presenter can reach
   * in one step into the keep-warm target (see the module comment). Nothing
   * while a transition or a build moves, or while the page is hidden.
   */
  keepWarm(): void {
    if (this.destroyed || this.busy() || !keepWarmEnabled()) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const renderer = this.sceneGraph.getApp().renderer
    const size: KeepWarmTarget = keepWarmTarget()
    const scale = size === 'pixel' ? null : size === 'eighth' ? 1 / 8 : 1
    const madeFor = `${size}@${renderer.resolution}`
    if (this.keepWarmTarget !== null && this.keepWarmTargetOf !== madeFor) {
      this.keepWarmTarget.destroy(true)
      this.keepWarmTarget = null
    }
    if (this.keepWarmTarget === null) {
      this.keepWarmTarget =
        scale === null
          ? RenderTexture.create({ width: 1, height: 1 })
          : RenderTexture.create({
              width: Math.ceil(SLIDE_WIDTH * scale),
              height: Math.ceil(SLIDE_HEIGHT * scale),
              resolution: renderer.resolution,
            })
      this.keepWarmTarget.label = KEEP_WARM_LABEL
      this.keepWarmTargetOf = madeFor
    }
    const target = this.keepWarmTarget
    // A scene drawn whole into the target, from its own origin, scaled to it.
    const transform = scale === null ? undefined : new Matrix().scale(scale, scale)
    const roots: Container[] = []
    // The scene on stage: its render group only (a scene mounted change by
    // change has none, and drawing it alone would make the stage's root one).
    const onStage = this.sceneGraph.getRoot()
    if (onStage.isRenderGroup && !onStage.destroyed) roots.push(onStage)
    for (const id of this.required) {
      const p = this.entries.get(id)?.prepared
      if (p != null && !p.root.destroyed) roots.push(p.root)
    }
    for (const root of roots)
      renderer.render({
        container: root,
        target,
        clear: true,
        ...(transform !== undefined ? { transform } : {}),
      })
    // The screen path too (see the module comment) — unless Pixi's ticker
    // presents frames anyway (a video or a timeline playing).
    const mode = keepWarmFrame()
    if (mode === 'none' || this.sceneGraph.getApp().ticker.started) return
    if (mode === 'now') {
      asKeepWarmFrame(() => getDefaultRenderScheduler()?.renderNow())
      return
    }
    requestAnimationFrame((frameStart) => {
      const scheduler = getDefaultRenderScheduler()
      if (scheduler === null || this.destroyed || this.busy()) return
      if (this.sceneGraph.getApp().ticker.started) return
      // A frame of the scheduler's presents this frame anyway.
      if (scheduler.framePending || scheduler.lastRenderAt >= frameStart) return
      asKeepWarmFrame(() => scheduler.renderNow())
    })
  }

  private scheduleKeepWarm(): void {
    if (this.destroyed || !this.idleOnly || this.keepWarmCancel !== null) return
    let cancelIdle: (() => void) | null = null
    const timer = setTimeout(() => {
      cancelIdle = whenPresentIdle(() => {
        this.keepWarmCancel = null
        this.keepWarm()
        this.scheduleKeepWarm()
      }, KEEP_WARM_MS)
    }, KEEP_WARM_MS)
    this.keepWarmCancel = () => {
      clearTimeout(timer)
      cancelIdle?.()
    }
  }

  private stopKeepWarm(): void {
    this.keepWarmCancel?.()
    this.keepWarmCancel = null
  }

  private warm(root: Container): void {
    const renderer = this.sceneGraph.getApp().renderer
    this.warmTarget ??= RenderTexture.create({ width: 1, height: 1 })
    renderer.render({ container: root, target: this.warmTarget, clear: true })
  }

  private async build(spec: PresentSlideSpec): Promise<void> {
    await this.turn()
    if (this.destroyed) return
    // A stale scene of this slide goes first (it may be what the budget is full of).
    if (this.entries.has(spec.slide.id)) this.evict(spec.slide.id)

    const scene = this.mount(spec)
    perfCount('present.prepare.slide')
    const deadline = performance.now() + this.settleTimeoutMs
    const until = <T>(p: Promise<T>): Promise<T | undefined> => {
      const left = deadline - performance.now()
      if (left <= 0) return Promise.resolve(undefined)
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        p,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), left)
        }),
      ]).finally(() => clearTimeout(timer))
    }

    // Pictures, fonts: every load the scene started (renderWork.ts). A load
    // whose texture is cached already adds its sprite a few microtasks after
    // the count reads zero (nothing of it is pending any more): a task later
    // every such chain has run, and a chain that started something new has
    // it counted again.
    const settleLoads = async (): Promise<void> => {
      for (let i = 0; i < 20 && !this.destroyed; i++) {
        await until(whenRenderWorkIdle())
        await until(new Promise<void>((resolve) => setTimeout(resolve, 0)))
        if (pendingRenderWork() === 0) return
      }
    }
    await settleLoads()
    const fonts = typeof document === 'undefined' ? undefined : document.fonts
    if (fonts !== undefined) await until(fonts.ready.then(() => undefined))
    const uid = this.sceneGraph.getApp().renderer.uid
    const drawn = new WeakSet<Promise<unknown>>()
    /** The texture sources the last warm-up drew (and so uploaded). */
    let warmed = new Set<TextureSource>()
    const warmNow = (): void => {
      this.warm(scene.root)
      warmed = collectSources(scene.root, uid)
    }
    for (let pass = 0; pass < 8 && !this.destroyed; pass++) {
      await this.turn()
      // Uploads every picture and starts every text raster (the first pass),
      // then draws the rasters that landed.
      warmNow()
      const fresh = collectHtmlTextRasters(scene.root, uid).filter((p) => !drawn.has(p))
      if (fresh.length === 0) break
      await until(Promise.allSettled(fresh))
      for (const p of fresh) drawn.add(p)
      // A raster that landed may have laid its text out again (textRenderer
      // realignIfMeasureMoved): its next frame of the loop draws that too.
      await until(new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
    // A picture that arrived after the last warm-up (a load that ended late)
    // would be uploaded by the frame that shows it: draw it here.
    for (let extra = 0; extra < 3 && !this.destroyed; extra++) {
      await settleLoads()
      const now = collectSources(scene.root, uid)
      if ([...now].every((source) => warmed.has(source))) break
      await this.turn()
      warmNow()
    }
    if (this.destroyed) {
      destroySlideScene(scene)
      return
    }

    scene.sources = collectSources(scene.root, uid)
    // Make room: drop resident scenes of lower priority until this one fits.
    const rank = (id: string): number => this.plan.findIndex((s) => s.slide.id === id)
    const mine = rank(spec.slide.id)
    const force = this.required.has(spec.slide.id)
    let admitted = this.rm.admitResident(spec.slide.id, scene.sources, { force })
    while (!admitted) {
      const victim = [...this.entries.keys()]
        .filter((id) => !this.required.has(id) && (rank(id) < 0 || rank(id) > mine))
        .sort((a, b) => rank(b) - rank(a))[0]
      if (victim === undefined) break
      this.evict(victim)
      admitted = this.rm.admitResident(spec.slide.id, scene.sources, { force })
    }
    if (!admitted || mine < 0) {
      if (mine >= 0) this.budgetFull = true
      destroySlideScene(scene)
      return
    }
    this.built.set(scene.root, scene)
    // A face or a token colour that changed while it was being built: it is
    // already stale (the listeners above only see scenes already kept).
    const stale =
      fontSignatureOf(scene.serialised) !== scene.fontSignature ||
      tokenColourSignature(spec.slide.objects, spec.surface) !== scene.tokenSignature
    this.entries.set(spec.slide.id, { spec, prepared: scene, stale })
  }

  /** The pictures' variants for the deck (see `variantFloor`); slides built from now on use them. */
  setVariantFloor(floor: ReadonlyMap<string, ImageVariant>): void {
    this.variantFloor = floor
  }

  /** Mount the slide off stage, painted as the scene graph would paint it as the active slide. */
  private mount(spec: PresentSlideSpec): PreparedSlide {
    const root = new Container()
    // Its own render group: built and drawn once here, it keeps its
    // instructions when it goes on stage, and a transition moving it moves
    // one transform instead of every object's.
    root.enableRenderGroup()
    const background = new Container()
    background.eventMode = 'none'
    root.addChild(background)

    const resolver = (() => {
      try {
        return getDefaultImageUrlResolver()
      } catch {
        return null
      }
    })()
    const rm = this.rm
    void applyBackground({
      container: background,
      // A slide without one has the default, as the editor and the
      // thumbnails draw it (useSlideBackground, thumbnails.ts) — not the
      // canvas's black showing through.
      background: spec.slide.background ?? DEFAULT_BACKGROUND,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      ...(resolver !== null
        ? { resolveAssetUrl: (assetId: string) => resolver({ assetId, variant: 'display' }) }
        : {}),
      acquireTexture: (url) => rm.acquireTexture(url),
      releaseTexture: (url) => rm.releaseTexture(url),
    })

    const bounds = this.sceneGraph.getSlideBounds()
    const nodes: PreparedSlide['nodes'] = []
    const savedNumber = getRenderingSlideNumber()
    let paintedWith: ColourResolverFn | null = null
    try {
      setRenderingSlideNumber(spec.slideNumber)
      const floor = this.variantFloor
      // A build that scales a picture up wants display (imageVariant.ts);
      // the preload's variants say so too, this covers builds edited since.
      const scaledUp = scaledUpObjectIds(spec.slide)
      withRenderingSurface(spec.surface, () => {
        paintedWith = getColourResolver()
        for (const data of spec.slide.objects) {
          const renderer = getRenderer(data.type)
          if (renderer === undefined) continue
          perfCountFor('sg.mount', data.type)
          // For the canvas it will be shown on, at the deck's variants.
          const container = withPixelDensity(
            this.sceneGraph.getPixelDensity(),
            () => renderer.mount(data),
            (picture) => (scaledUp.has(picture.id) ? 'display' : floor.get(picture.assetId)),
          )
          container.alpha = outsideFadeAlpha(data as SlideObject, bounds.width, bounds.height)
          root.addChild(container)
          nodes.push({ id: data.id, container, data })
        }
      })
      for (const n of nodes) {
        if (n.data.type !== 'video') continue
        const el = this.liveVideo(n.id)
        if (el !== null) attachLiveVideo(n.id, el)
      }
    } finally {
      setRenderingSlideNumber(savedNumber)
    }

    const serialised = serialiseThumbnailInputs({
      objects: spec.slide.objects,
      background: spec.slide.background,
      surface: spec.surface,
    })
    const baselines = new Map<Container, Baseline>()
    baselines.set(root, takeBaseline(root))
    baselines.set(background, takeBaseline(background))
    for (const n of nodes) baselines.set(n.container, takeBaseline(n.container))

    return {
      slideId: spec.slide.id,
      root,
      background,
      nodes,
      paintedWith,
      objects: spec.slide.objects,
      surface: spec.surface,
      spec,
      tokenSignature: tokenColourSignature(spec.slide.objects, spec.surface),
      serialised,
      fontSignature: fontSignatureOf(serialised),
      baselines,
      sources: new Set(),
    }
  }
}
