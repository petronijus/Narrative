/**
 * renderer/textResolutionStaging.ts — hand a new resolution to the scene's
 * texts a few at a time, the ones on screen first.
 *
 * A zoom changes `renderer.resolution`, and Pixi re-rasterises every
 * auto-resolution HTMLText at once on that change (its `resolutionChange`
 * runner): with 300 texts that is one frame with ~1.5 Gpx of texture upload
 * (docs/plans/canvas-performance.md, step 3). SceneGraph instead pins each
 * text to the resolution it was drawn at before the change and gives them the
 * new one through a `BatchStager`: a bounded amount of raster work per
 * animation frame, in the order `stagingOrder` puts them. A newer zoom restarts the staging; the
 * generation counter makes sure a frame of the older one never runs.
 *
 * Pure: no Pixi, no DOM beyond the frame/idle callbacks it is handed (or the
 * window's, by default), so the batching and cancellation are unit-tested
 * (textResolutionStaging.test.ts).
 */

/** An axis-aligned rectangle (Pixi's stage space: CSS pixels of the canvas). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** `rect` grown about its centre by `fraction` of its size (0.25: 25 % wider and taller). */
export function widenRect(rect: Rect, fraction: number): Rect {
  const dx = (rect.width * fraction) / 2
  const dy = (rect.height * fraction) / 2
  return {
    x: rect.x - dx,
    y: rect.y - dy,
    width: rect.width + 2 * dx,
    height: rect.height + 2 * dy,
  }
}

/** How far apart two rectangles are (0 when they touch or overlap). */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width))
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height))
  return Math.hypot(dx, dy)
}

/**
 * The order to stage `items` in: those meeting `viewport` first, then the
 * rest by their distance from it (nearest first, so a scroll reaches sharp
 * text sooner), items without a box last. Ties keep the input order (scene
 * order). Without a viewport the input order is kept.
 */
export function stagingOrder<T>(
  items: readonly T[],
  boxOf: (item: T) => Rect | null,
  viewport: Rect | null,
): T[] {
  if (viewport === null) return [...items]
  const keyed = items.map((item, index) => {
    const box = boxOf(item)
    return { item, index, d: box === null ? Infinity : rectDistance(box, viewport) }
  })
  keyed.sort((a, b) => a.d - b.d || a.index - b.index)
  return keyed.map((k) => k.item)
}

/**
 * What one job set going: its cost in the stager's budget units
 * (SceneGraph: texture pixels), and, when the work finishes later (a
 * raster lands asynchronously), how to tell that it has.
 */
export interface StagedWork {
  cost: number
  settled?: () => boolean
}

/** One unit of staged work; null when it found nothing to do — it then takes no place in a batch. */
export type StagedJob = () => StagedWork | null

export interface FrameSource {
  request(cb: () => void): number
  cancel(handle: number): void
}

/** The window's animation frames. A hidden page gets none: a staging waits there, as the renderer does. */
export const animationFrames: FrameSource = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
}

export interface BatchStagerOptions {
  /** At most this many jobs that did work per frame. */
  maxJobs: number
  /**
   * A batch ends once its jobs have cost this much (default: no limit). The
   * job that crosses it still runs, so every frame makes progress.
   */
  budget?: number
  /**
   * Before the next batch, wait (a frame at a time, this many at most) for
   * the previous batch's work to have settled. Default 0: no waiting. Work
   * that finishes outside the frame it was started in — Pixi uploads an
   * HTMLText's raster when its SVG image loads, and several loads can land in
   * one task — is only bounded per task if a batch waits for the last.
   */
  maxWaitFrames?: number
  frames?: FrameSource
  /** After a batch that did work (SceneGraph: ask for a render). */
  onBatch?: () => void
}

/**
 * Runs a list of jobs a batch per frame — `maxJobs` jobs or `budget` of
 * cost, whichever comes first, each batch after the previous one's work has
 * settled (`maxWaitFrames`). The first batch runs at once,
 * in the `stage()` call: what is on screen starts rasterising in the very
 * next render. `stage()` again drops what the previous staging had left;
 * `cancel()` drops it with nothing new.
 */
export class BatchStager {
  private readonly maxJobs: number
  private readonly budget: number
  private readonly maxWaitFrames: number
  private readonly frames: FrameSource
  private readonly onBatch: (() => void) | undefined
  private queue: StagedJob[] = []
  private cursor = 0
  /** The previous batch's unsettled work, and the frames already waited for it. */
  private inFlight: Array<() => boolean> = []
  private waited = 0
  private handle: number | null = null
  /** Bumped by every stage/cancel; a frame scheduled under an older value does nothing. */
  private generation = 0

  constructor(opts: BatchStagerOptions) {
    this.maxJobs = Math.max(1, Math.floor(opts.maxJobs))
    this.budget = opts.budget ?? Infinity
    this.maxWaitFrames = Math.max(0, Math.floor(opts.maxWaitFrames ?? 0))
    this.frames = opts.frames ?? animationFrames
    this.onBatch = opts.onBatch
  }

  /** Jobs not yet run. */
  get pending(): number {
    return this.queue.length - this.cursor
  }

  stage(jobs: readonly StagedJob[]): void {
    this.cancel()
    this.queue = [...jobs]
    this.cursor = 0
    this.runBatch(this.generation)
  }

  cancel(): void {
    this.generation++
    if (this.handle !== null) this.frames.cancel(this.handle)
    this.handle = null
    this.queue = []
    this.cursor = 0
    this.inFlight = []
    this.waited = 0
  }

  private next(generation: number): void {
    this.handle = this.frames.request(() => this.runBatch(generation))
  }

  private runBatch(generation: number): void {
    if (generation !== this.generation) return
    this.handle = null
    if (this.inFlight.length > 0) {
      this.inFlight = this.inFlight.filter((settled) => !settled())
      if (this.inFlight.length > 0 && this.waited < this.maxWaitFrames) {
        this.waited++
        this.next(generation)
        return
      }
    }
    this.inFlight = []
    this.waited = 0
    let done = 0
    let spent = 0
    while (done < this.maxJobs && spent < this.budget && this.cursor < this.queue.length) {
      const work = this.queue[this.cursor++]!()
      if (work === null) continue
      done++
      spent += Math.max(0, work.cost)
      if (work.settled !== undefined && this.maxWaitFrames > 0) this.inFlight.push(work.settled)
    }
    if (done > 0) this.onBatch?.()
    if (this.cursor < this.queue.length) {
      this.next(generation)
    } else {
      this.queue = []
      this.cursor = 0
      this.inFlight = []
    }
  }
}

/**
 * Run `cb` when the main thread is idle — after the input events already
 * queued (a wheel event that cancels it runs first) — or after `timeout` ms
 * at the latest. Returns the cancel. Safari has no `requestIdleCallback`; a
 * zero timeout queues behind the same events there.
 */
export function whenIdle(cb: () => void, timeout: number): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(cb, { timeout })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(cb, 0)
  return () => clearTimeout(handle)
}
