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
 * animation frame, in the order `stagingOrder` puts them — the texts on
 * screen in frames, the rest when the main thread is idle. A newer zoom
 * replaces the staging (texts already at its resolution are skipped); the
 * generation counter makes sure a frame of the older one never runs. While
 * a zoom gesture is still going the staging is paused, so no raster is
 * started for a resolution about to be replaced.
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

/** One text as `planTextResolutions` sees it. */
export interface ResolutionPlanItem {
  /** Its box (stage space); null: unknown (staged last, held to the cap when there is one). */
  box: Rect | null
  /** The resolution its raster has now (0: none yet). */
  now: number
  /** The pixels its raster would have at the staging's resolution (an estimate). */
  px: number
}

/**
 * The texts beyond the view that may be held at the staging's full
 * resolution: their boxes meet `rect` (the canvas's drawn region around the
 * view), and the texts at full resolution — those in view included — add up
 * to at most `budgetPx` raster pixels.
 */
export interface ResolutionMargin {
  rect: Rect
  budgetPx: number
}

/**
 * Where each text goes in a zoom's staging (SceneGraph.restageTextResolution)
 * and in what order:
 *
 *   1. the texts meeting `viewport`: `resolution`, whatever it costs — what
 *      is visible is sharp and exact;
 *   2. those meeting only `margin.rect`, nearest first: `resolution` while
 *      the full-resolution pixels stay within `margin.budgetPx` — a short
 *      scroll then shows them sharp at once; past the budget, the cap;
 *   3. the rest, nearest first: `offscreenCap`, or what they have when it
 *      lies between the cap and `resolution` (a scroll does not churn
 *      rasters) and the budget still holds it — over the budget a text that
 *      left the view goes down to the cap, so scrolling about a crowded slide
 *      at a high zoom cannot gather every text at full resolution.
 *
 * Without a viewport every text gets `resolution`. `deferFrom`: the first
 * position not at full resolution in group 1 or 2 (the stager runs the
 * groups before it in frames, the rest in idle callbacks). Pure.
 */
export function planTextResolutions(
  items: readonly ResolutionPlanItem[],
  resolution: number,
  viewport: Rect | null,
  margin: ResolutionMargin | null,
  offscreenCap: number,
): { order: number[]; targets: number[]; deferFrom: number } {
  if (viewport === null) {
    return {
      order: items.map((_, i) => i),
      targets: items.map(() => resolution),
      deferFrom: items.length,
    }
  }
  const capped = Math.min(resolution, offscreenCap)
  const keyed = items.map((item, index) => {
    const d = item.box === null ? Infinity : rectDistance(item.box, viewport)
    const group =
      d === 0
        ? 0
        : item.box !== null && margin !== null && rectDistance(item.box, margin.rect) === 0
          ? 1
          : 2
    return { item, index, d, group }
  })
  keyed.sort((a, b) => a.group - b.group || a.d - b.d || a.index - b.index)
  const budget = margin?.budgetPx ?? Infinity
  let full = 0
  let exhausted = false
  let deferFrom = keyed.length
  const targets = keyed.map(({ item, group }, i) => {
    if (group === 0 || capped >= resolution) {
      full += item.px
      return resolution
    }
    const wants =
      group === 1 ? resolution : item.now >= capped && item.now <= resolution ? item.now : capped
    let target = capped
    if (wants > capped && !exhausted) {
      const px = item.px * (wants / resolution) ** 2
      if (full + px <= budget) {
        full += px
        target = wants
      } else exhausted = true
    } else if (wants <= capped) target = wants
    if (deferFrom === keyed.length && !(group === 1 && target === resolution)) deferFrom = i
    return target
  })
  return { order: keyed.map((k) => k.index), targets, deferFrom }
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

/** How long a staging waits for an animation frame before it goes on without one. */
export const FRAME_FALLBACK_MS = 250

/**
 * The window's animation frames — or `FRAME_FALLBACK_MS`, whichever comes
 * first. A page that draws no frames (a hidden or occluded window, a
 * compositor that stalled: a dev page at 400 % on battery drew none for over
 * a minute, 2026-10-30) still gets its texts' new resolutions; their rasters
 * follow when it draws again, as they did before the staging spread them.
 */
const frameTimers = new Map<number, ReturnType<typeof setTimeout>>()
const rafOf = new Map<number, number>()
let nextFrameHandle = 1
export const animationFrames: FrameSource = {
  request: (cb) => {
    const handle = nextFrameHandle++
    let done = false
    const run = (): void => {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
      clearTimeout(frameTimers.get(handle))
      frameTimers.delete(handle)
      rafOf.delete(handle)
      cb()
    }
    const raf = requestAnimationFrame(run)
    frameTimers.set(handle, setTimeout(run, FRAME_FALLBACK_MS))
    rafOf.set(handle, raf)
    return handle
  },
  cancel: (handle) => {
    const raf = rafOf.get(handle)
    if (raf !== undefined) cancelAnimationFrame(raf)
    clearTimeout(frameTimers.get(handle))
    frameTimers.delete(handle)
    rafOf.delete(handle)
  },
}

/** Callbacks for when the main thread is idle, `timeout` ms at the latest. */
export interface IdleSource {
  request(cb: () => void, timeout: number): number
  cancel(handle: number): void
}

/**
 * The window's idle callbacks. Safari has no `requestIdleCallback`: a zero
 * timeout queues behind the input already waiting there, which is what a
 * deferred batch needs to give way to.
 */
export const idleCallbacks: IdleSource = {
  request: (cb, timeout) =>
    typeof requestIdleCallback === 'function'
      ? requestIdleCallback(cb, { timeout })
      : (setTimeout(cb, 0) as unknown as number),
  cancel: (handle) => {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle)
    else clearTimeout(handle)
  },
}

export interface BatchStagerOptions {
  /**
   * At most this many jobs that did work per frame. A function is asked at
   * the start of every batch (Infinity: no count limit).
   */
  maxJobs: number | (() => number)
  /**
   * A batch ends once its jobs have cost this much (default: no limit). The
   * job that crosses it still runs, so every frame makes progress. A
   * function is asked at the start of every batch (a budget that adapts to
   * what the work has been costing).
   */
  budget?: number | (() => number)
  /**
   * Before the next batch, wait (a frame at a time, this many at most) for
   * the previous batch's work to have settled. Default 0: no waiting. Work
   * that finishes outside the frame it was started in — Pixi uploads an
   * HTMLText's raster when its SVG image loads, and several loads can land in
   * one task — is only bounded per task if a batch waits for the last.
   */
  maxWaitFrames?: number
  frames?: FrameSource
  /** Where the deferred part of a staging runs (`stage(jobs, { deferFrom })`). */
  idle?: IdleSource
  /** A deferred batch runs this long after it was due at the latest, idle or not (default 1000 ms). */
  idleTimeout?: number
  /** After a batch that did work (SceneGraph: ask for a render). */
  onBatch?: () => void
}

export interface StageOptions {
  /**
   * The jobs from this index on are deferred: they run a batch per idle
   * callback, after every job before it. Default: none (all in frames).
   */
  deferFrom?: number
}

/**
 * Runs a list of jobs a batch per frame — `maxJobs` jobs or `budget` of
 * cost, whichever comes first, each batch after the previous one's work has
 * settled (`maxWaitFrames`). The first batch runs at once, in the `stage()`
 * call: what is on screen starts rasterising in the very next render. The
 * deferred tail of a staging (`deferFrom`) runs the same way, a batch per
 * idle callback. `stage()` again drops what the previous staging had left;
 * `cancel()` drops it with nothing new; `pause()` keeps it, unscheduled,
 * until `resume()` (or a new `stage()`).
 */
export class BatchStager {
  private readonly maxJobs: () => number
  private readonly budget: () => number
  private readonly maxWaitFrames: number
  private readonly frames: FrameSource
  private readonly idle: IdleSource
  private readonly idleTimeout: number
  private readonly onBatch: (() => void) | undefined
  private queue: StagedJob[] = []
  private cursor = 0
  private deferFrom = Infinity
  /** The previous batch's unsettled work, and the frames already waited for it. */
  private inFlight: Array<() => boolean> = []
  private waited = 0
  /** The scheduled callback and where it was asked from. */
  private handle: { id: number; source: 'frame' | 'idle' } | null = null
  private isPaused = false
  /** Bumped by every stage/cancel; a frame scheduled under an older value does nothing. */
  private generation = 0

  constructor(opts: BatchStagerOptions) {
    const maxJobs = opts.maxJobs
    this.maxJobs =
      typeof maxJobs === 'function'
        ? () => Math.max(1, Math.floor(maxJobs()))
        : () => Math.max(1, Math.floor(maxJobs))
    const budget = opts.budget ?? Infinity
    this.budget = typeof budget === 'function' ? budget : () => budget
    this.maxWaitFrames = Math.max(0, Math.floor(opts.maxWaitFrames ?? 0))
    this.frames = opts.frames ?? animationFrames
    this.idle = opts.idle ?? idleCallbacks
    this.idleTimeout = opts.idleTimeout ?? 1000
    this.onBatch = opts.onBatch
  }

  /** Jobs not yet run. */
  get pending(): number {
    return this.queue.length - this.cursor
  }

  /** True between `pause()` and the next `resume()` / `stage()` / `cancel()`. */
  get paused(): boolean {
    return this.isPaused
  }

  stage(jobs: readonly StagedJob[], opts: StageOptions = {}): void {
    this.cancel()
    this.queue = [...jobs]
    this.cursor = 0
    this.deferFrom = Math.max(0, opts.deferFrom ?? Infinity)
    if (this.deferFrom > 0) this.runBatch(this.generation)
    else this.next(this.generation)
  }

  cancel(): void {
    this.generation++
    this.unschedule()
    this.queue = []
    this.cursor = 0
    this.deferFrom = Infinity
    this.inFlight = []
    this.waited = 0
    this.isPaused = false
  }

  /** Stop running batches; what is left stays queued. */
  pause(): void {
    if (this.isPaused) return
    this.isPaused = true
    this.unschedule()
  }

  /** Go on with what a `pause()` left (nothing to do when nothing is left). */
  resume(): void {
    if (!this.isPaused) return
    this.isPaused = false
    if (this.pending > 0) this.next(this.generation)
  }

  private unschedule(): void {
    if (this.handle === null) return
    if (this.handle.source === 'frame') this.frames.cancel(this.handle.id)
    else this.idle.cancel(this.handle.id)
    this.handle = null
  }

  private next(generation: number): void {
    if (this.isPaused) return
    const run = (): void => this.runBatch(generation)
    this.handle =
      this.cursor >= this.deferFrom
        ? { id: this.idle.request(run, this.idleTimeout), source: 'idle' }
        : { id: this.frames.request(run), source: 'frame' }
  }

  private runBatch(generation: number): void {
    if (generation !== this.generation || this.isPaused) return
    this.handle = null
    if (this.inFlight.length > 0) {
      this.inFlight = this.inFlight.filter((settled) => !settled())
      if (this.inFlight.length > 0 && this.waited < this.maxWaitFrames) {
        this.waited++
        // Waited a frame at a time in the deferred part too: a wait is for
        // the GPU to take the last batch, not for the main thread to be
        // idle — counted in idle callbacks, a page that is never idle (each
        // one then comes at its timeout) waited a second a wait, and an
        // off-screen tail of 100 texts took minutes.
        this.handle = { id: this.frames.request(() => this.runBatch(generation)), source: 'frame' }
        return
      }
    }
    this.inFlight = []
    this.waited = 0
    // A batch is all in frames or all deferred, never both.
    const end =
      this.cursor < this.deferFrom ? Math.min(this.deferFrom, this.queue.length) : this.queue.length
    const budget = this.budget()
    const maxJobs = this.maxJobs()
    let done = 0
    let spent = 0
    while (done < maxJobs && spent < budget && this.cursor < end) {
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
      this.deferFrom = Infinity
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
  const handle = idleCallbacks.request(cb, timeout)
  return () => idleCallbacks.cancel(handle)
}
