/**
 * renderer/textureUploadGate.ts — the GPU uploads of large textures, a
 * bounded amount per animation frame (docs/plans/performance.md → Remaining
 * backlog, "One large texture upload per frame"; W4 in the Log).
 *
 * A picture's main-thread cost in WebKit is its upload, not its decode
 * (Pixi decodes in its workers): W4 measured ~20 ms for a 2560 px `display`
 * texture and ~5 ms for a 1280 px `medium` one (Chromium ~6 and ~1). Pixi
 * uploads a texture lazily, in the first render that binds it, so every
 * texture that became ready since the previous frame is uploaded by the next
 * one: a slide switch, a zoom commit that swaps pictures to a larger
 * variant, or a dozen pictures decoded at once by Pixi's workers (one per
 * core) stacked their uploads into one long frame.
 *
 * The ResourceManager hands a texture loaded from a URL out only once it has
 * passed this gate (`admit`): textures above `smallPx` that are not on the
 * GPU yet are queued, and each animation frame uploads queued ones until
 * their pixels reach the frame's budget, explicitly, through Pixi's own
 * upload entry point (`renderer.texture.initSource`, what Pixi's prepare
 * plugin calls). The first texture of a frame always goes, whatever its
 * size, so a texture larger than the budget still gets a frame to itself and
 * nothing waits for ever on its size. Until its texture is admitted an
 * object keeps showing what it showed: its placeholder, or its smaller
 * variant (an upgrade swaps only once the larger texture is resolved). The
 * frame that draws it then has nothing left to upload.
 *
 * Order: the textures whose object meets the viewport, the ones replacing a
 * placeholder before the ones replacing a smaller variant, then the rest of
 * the stage, then scenes built off stage (present mode's preparation); first
 * come first within each. A texture that has waited `maxWaitFrames` goes
 * before all of them (oldest first), so a steady stream of visible pictures
 * cannot starve one off screen.
 *
 * Small textures (icons, `thumb` pictures; text rasters never come here) and
 * textures already on the GPU (a picture shared by two objects, one taken
 * back within the ResourceManager's grace) pass at once.
 *
 * A hidden page gets no animation frames (RenderScheduler's invariant): there
 * the queue is drained at once, unbudgeted — no frame is being shown.
 * `setHold` holds the queue while present mode animates (a transition, a
 * build): a slide built in idle time after ready uploads between them.
 *
 * Pure: no Pixi beyond types, no DOM beyond the callbacks it is handed (or
 * the window's, by default) — textureUploadGate.test.ts drives it by hand.
 */

import type { Container, Renderer, TextureSource } from 'pixi.js'
import { perfCount, perfCountersOn, readPerfCounters } from '@narrative/shared'
import { AdaptiveBudget, LongTaskWatch } from './restageBudget.js'
import {
  animationFrames,
  rectDistance,
  type FrameSource,
  type Rect,
} from './textResolutionStaging.js'

/**
 * Texture pixels a frame uploads (after its first texture, which always
 * goes). 2.25 Mpx: two 1280 px `medium` pictures (1.09 Mpx each, ~5 ms each in
 * WebKit) share a frame, a 2560 px `display` (4.37 Mpx, ~20 ms) has one to
 * itself. Where the browser reports long tasks (Chromium, whose uploads are
 * ~3.5× faster) the budget follows them within the bounds below.
 */
export const UPLOAD_PX_PER_FRAME = 2_250_000
export const UPLOAD_MIN_PX = 1_100_000
export const UPLOAD_MAX_PX = 9_000_000
/** At or below this many pixels a texture is uploaded by the frame that draws it (512 × 512). */
export const SMALL_UPLOAD_PX = 512 * 512
/** A texture that has waited this many frames goes first (≈ 0.5 s at 60 Hz). */
export const UPLOAD_MAX_WAIT_FRAMES = 30

/** Where uploads go: Pixi's texture system (`pixiUploadTarget`), or a test double. */
export interface UploadTarget {
  /** Whether the source has its GPU texture already (an upload would do nothing). */
  isUploaded(source: TextureSource): boolean
  /** Create and fill the source's GPU texture now. */
  upload(source: TextureSource): void
}

/** What a texture is wanted for: where it is drawn, and what its object shows meanwhile. */
export interface UploadPriority {
  /** The object it is for (stage space through the gate's `locate`). Absent: assumed on screen. */
  node?: Container
  /** It replaces a smaller variant the object already shows (not a placeholder). */
  upgrade?: boolean
}

/** The page's visibility (a hidden page gets no animation frames). */
export interface VisibilitySource {
  hidden(): boolean
  /** Be told when it changes; returns the unsubscribe. */
  subscribe(cb: () => void): () => void
}

/** The document's visibility; never hidden where there is no document. */
export const documentVisibility: VisibilitySource = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  subscribe: (cb) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', cb)
    return () => document.removeEventListener('visibilitychange', cb)
  },
}

export interface TextureUploadGateOptions {
  /** Pixels per frame after the first texture; a function is asked once per frame that uploads. */
  budget?: number | (() => number)
  smallPx?: number
  maxWaitFrames?: number
  frames?: FrameSource
  visibility?: VisibilitySource
  /** The part of the stage the window shows (stage space), null when unknown. */
  viewport?: () => Rect | null
  /** Where `node` is drawn in stage space; null when it is not on the stage. */
  locate?: (node: Container) => Rect | null
}

interface Waiter {
  resolve: () => void
  priority: UploadPriority | undefined
}

interface Queued {
  source: TextureSource
  px: number
  /** Arrival order. */
  seq: number
  /** The gate's frame count when it arrived: its first chance is the next frame. */
  arrivedAt: number
  /** It has missed a frame it could have gone in (counted once). */
  deferred: boolean
  waiters: Waiter[]
}

/** Order tiers (lower first); an aged texture goes before every tier. */
const TIER_OFF_STAGE = 4

export class TextureUploadGate {
  private readonly budget: () => number
  private readonly smallPx: number
  private readonly maxWaitFrames: number
  private readonly frames: FrameSource
  private readonly visibility: VisibilitySource
  private readonly viewport: (() => Rect | null) | undefined
  private readonly locate: ((node: Container) => Rect | null) | undefined
  private readonly queue = new Map<TextureSource, Queued>()
  private readonly unsubscribeVisibility: () => void
  private hold: (() => boolean) | null = null
  private frameHandle: number | null = null
  private drainQueued = false
  /** Frames that ran the queue (held ones not counted). */
  private frame = 0
  private seq = 0
  private destroyed = false

  constructor(
    private target: UploadTarget | null,
    opts: TextureUploadGateOptions = {},
  ) {
    const budget = opts.budget ?? UPLOAD_PX_PER_FRAME
    this.budget = typeof budget === 'function' ? budget : () => budget
    this.smallPx = opts.smallPx ?? SMALL_UPLOAD_PX
    this.maxWaitFrames = Math.max(1, Math.floor(opts.maxWaitFrames ?? UPLOAD_MAX_WAIT_FRAMES))
    this.frames = opts.frames ?? animationFrames
    this.visibility = opts.visibility ?? documentVisibility
    this.viewport = opts.viewport
    this.locate = opts.locate
    this.unsubscribeVisibility = this.visibility.subscribe(() => {
      if (this.visibility.hidden() && this.queue.size > 0) this.drainSoon()
    })
  }

  /** Textures waiting for a frame. */
  get pending(): number {
    return this.queue.size
  }

  /**
   * Resolves once `source` is on the GPU (or needs no gate: small, uploaded
   * already, destroyed, the gate gone). Never rejects. Admitting a source
   * that is queued already adds a waiter (and its priority) to it.
   */
  admit(source: TextureSource, priority?: UploadPriority): Promise<void> {
    const target = this.target
    if (this.destroyed || target === null || source.destroyed) return Promise.resolve()
    const px = Math.max(0, source.pixelWidth) * Math.max(0, source.pixelHeight)
    if (px <= this.smallPx || target.isUploaded(source)) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve, priority }
      const queued = this.queue.get(source)
      if (queued !== undefined) {
        queued.waiters.push(waiter)
        return
      }
      this.queue.set(source, {
        source,
        px,
        seq: this.seq++,
        arrivedAt: this.frame,
        deferred: false,
        waiters: [waiter],
      })
      this.schedule()
    })
  }

  /** While `probe` answers true, frames upload nothing (present mode's transitions and builds). */
  setHold(probe: (() => boolean) | null): void {
    this.hold = probe
    if (probe === null && this.queue.size > 0) this.schedule()
  }

  /** Upload everything queued now, unbudgeted. */
  flush(): void {
    if (this.destroyed) return
    this.cancelFrame()
    this.drainQueued = false
    for (const item of this.ordered()) this.uploadItem(item)
  }

  /** Let every waiter go without uploading (the renderer is going); the gate does nothing after. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.cancelFrame()
    this.unsubscribeVisibility()
    for (const item of this.queue.values()) this.settle(item)
    this.queue.clear()
    this.target = null
    this.hold = null
  }

  private schedule(): void {
    if (this.destroyed || this.queue.size === 0) return
    if (this.visibility.hidden()) {
      this.drainSoon()
      return
    }
    if (this.frameHandle !== null) return
    this.frameHandle = this.frames.request(() => {
      this.frameHandle = null
      this.runFrame()
    })
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return
    this.frames.cancel(this.frameHandle)
    this.frameHandle = null
  }

  /** A hidden page: no frame will come. A microtask, so `admit` never settles inside itself. */
  private drainSoon(): void {
    this.cancelFrame()
    if (this.drainQueued) return
    this.drainQueued = true
    queueMicrotask(() => {
      if (!this.drainQueued) return
      this.drainQueued = false
      this.flush()
    })
  }

  private runFrame(): void {
    if (this.destroyed || this.queue.size === 0) return
    if (this.hold?.() === true) {
      perfCount('rm.upload.held')
      this.schedule()
      return
    }
    this.frame++
    const budget = this.budget()
    let spent = 0
    let uploaded = 0
    for (const item of this.ordered()) {
      if (this.settledWithoutUpload(item)) continue
      if (uploaded > 0 && spent + item.px > budget) {
        if (!item.deferred) {
          item.deferred = true
          perfCount('rm.upload.deferred')
        }
        continue
      }
      if (item.deferred) perfCount('rm.upload.waitFrames', this.frame - item.arrivedAt - 1)
      this.uploadItem(item)
      spent += item.px
      uploaded++
    }
    if (uploaded > 0) {
      perfCount('rm.upload.frames')
      countMax('rm.upload.frameKpxMax', Math.round(spent / 1000))
    }
    this.schedule()
  }

  /** Destroyed, or uploaded by something else since (a render that drew it): it goes without a slot. */
  private settledWithoutUpload(item: Queued): boolean {
    if (!item.source.destroyed && this.target?.isUploaded(item.source) !== true) return false
    this.queue.delete(item.source)
    this.settle(item)
    return true
  }

  private uploadItem(item: Queued): void {
    if (this.settledWithoutUpload(item)) return
    this.queue.delete(item.source)
    try {
      this.target?.upload(item.source)
      perfCount('rm.upload.count')
      perfCount('rm.upload.kpx', Math.round(item.px / 1000))
    } catch (err) {
      // A lost context, a source Pixi cannot upload: the frame that draws it tries again.
      console.warn('[TextureUploadGate] upload failed; the render will retry it', err)
    }
    this.settle(item)
  }

  private settle(item: Queued): void {
    for (const w of item.waiters) w.resolve()
    item.waiters = []
  }

  /** The queue in upload order (see the module comment). */
  private ordered(): Queued[] {
    const items = [...this.queue.values()]
    if (items.length <= 1) return items
    let viewport: Rect | null | undefined
    const view = (): Rect | null => (viewport ??= this.viewport?.() ?? null)
    const keyed = items.map((item) => {
      const aged = this.frame - item.arrivedAt >= this.maxWaitFrames
      let tier = Infinity
      if (!aged) for (const w of item.waiters) tier = Math.min(tier, this.tierOf(w.priority, view))
      return { item, aged, tier }
    })
    keyed.sort((a, b) => {
      if (a.aged !== b.aged) return a.aged ? -1 : 1
      if (!a.aged && a.tier !== b.tier) return a.tier - b.tier
      return a.item.seq - b.item.seq
    })
    return keyed.map((k) => k.item)
  }

  private tierOf(priority: UploadPriority | undefined, view: () => Rect | null): number {
    const upgrade = priority?.upgrade === true ? 1 : 0
    const node = priority?.node
    if (node === undefined || this.locate === undefined) return upgrade
    const box = this.locate(node)
    if (box === null) return TIER_OFF_STAGE
    const viewport = view()
    if (viewport === null || rectDistance(box, viewport) === 0) return upgrade
    return 2 + upgrade
  }
}

/** Raise a high-water counter to `value` (counters only add). */
function countMax(key: string, value: number): void {
  if (!perfCountersOn()) return
  const current = readPerfCounters()[key] ?? 0
  if (value > current) perfCount(key, value - current)
}

/** Pixi's texture system as an upload target (WebGL and WebGPU alike). */
export function pixiUploadTarget(renderer: Renderer): UploadTarget {
  return {
    isUploaded: (source) => source._gpuData[renderer.uid] != null,
    upload: (source) => {
      renderer.texture.initSource(source)
    },
  }
}

/**
 * Where a node is drawn on `stage` (stage space), null when it is not under
 * it — destroyed, removed, or in a scene built off stage.
 */
export function stageLocator(stage: Container): (node: Container) => Rect | null {
  return (node) => {
    if (node.destroyed) return null
    let root: Container = node
    while (root.parent !== null) root = root.parent
    if (root !== stage) return null
    const b = node.getBounds()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  }
}

/**
 * The budget of `TextureUploadGate`: fixed where the browser reports no long
 * tasks (WebKit — where uploads are slowest); elsewhere it halves after a
 * frame that uploaded and saw a long task begin, and grows back by a quarter
 * after one that did not (renderer/restageBudget.ts).
 */
export function adaptiveUploadBudget(longTasks = LongTaskWatch.create()): () => number {
  if (longTasks === null) return () => UPLOAD_PX_PER_FRAME
  const budget = new AdaptiveBudget(UPLOAD_PX_PER_FRAME, UPLOAD_MIN_PX, UPLOAD_MAX_PX)
  let lastAt: number | null = null
  return () => {
    const now = performance.now()
    const since = lastAt
    lastAt = now
    if (since === null) return budget.value
    const longTask = longTasks.since(since)
    if (longTask) perfCount('rm.upload.shrunk')
    return budget.next(longTask)
  }
}
