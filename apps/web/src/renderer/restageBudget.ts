/**
 * renderer/restageBudget.ts — how much re-rasterising a zoom's staging may
 * start per batch, held to what the main thread can take without a long
 * task.
 *
 * What a batch of text rasters costs is paid later and elsewhere: in the
 * load callbacks of their SVG images, where Pixi measures the text again,
 * uploads the image (the browser draws the SVG there) and builds its
 * mipmaps — and several loads can land in one task. Its cost per pixel
 * differs several times between machines and with what else the page is
 * doing, and timing the upload call alone (tried 2026-10-18) measured ~1
 * ms/Mpx where the CPU profile has ~6: a budget from it grew the batches
 * and the long tasks with them.
 *
 * So the budget follows the outcome instead: `AdaptiveBudget` halves after
 * a batch during which a long task (≥ 50 ms) began, and grows by a quarter
 * after one without, within its bounds. `LongTaskWatch` reports the long
 * tasks (the Long Tasks API: Chromium, the desktop app's Electron; elsewhere
 * there is none and the caller keeps its fixed budget). A task that began
 * before the batch — the commit itself, ~110 ms of backbuffer reallocation
 * at the pixel cap — is not the batch's doing and does not count.
 *
 * A long task is not the only way a batch overruns. Run-text rasters
 * (ADR 0018) are painted in workers, so the main thread stays free while
 * their uploads and mipmaps land on the GPU: after a zoom commit two or three
 * frames took 33–100 ms with no task over 50 ms (`viewport.zoom.commit`,
 * 2026-10-30), and WebKit has no Long Tasks API at all (its staging ran at
 * a fixed budget, frame.p90 49 ms). `FrameGapWatch` counts those: a frame
 * that came later than one and a half display intervals after the last
 * while a staging runs is a batch that cost too much, as a long task is.
 */

/** A budget that halves after a long task and grows back without one. */
export class AdaptiveBudget {
  private current: number

  constructor(
    initial: number,
    private readonly min: number,
    private readonly max: number,
    private readonly shrink = 0.5,
    private readonly grow = 1.25,
  ) {
    this.current = Math.min(max, Math.max(min, initial))
  }

  get value(): number {
    return this.current
  }

  /** The budget for the next batch, after one that did (or did not) see a long task. */
  next(longTaskSeen: boolean): number {
    const scaled = this.current * (longTaskSeen ? this.shrink : this.grow)
    this.current = Math.min(this.max, Math.max(this.min, scaled))
    return this.current
  }
}

interface LongTaskEntry {
  startTime: number
  duration: number
}

/** The page's long tasks, as far back as the last question about them. */
export class LongTaskWatch {
  private entries: LongTaskEntry[] = []
  private readonly observer: { disconnect(): void }

  private constructor(
    observe: (onEntries: (e: LongTaskEntry[]) => void) => { disconnect(): void },
    private readonly minMs: number,
  ) {
    this.observer = observe((e) => {
      for (const entry of e) if (entry.duration >= this.minMs) this.entries.push(entry)
    })
  }

  /** A watch over the window's long tasks, or null where the browser reports none. */
  static create(minMs = 50): LongTaskWatch | null {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !(PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')
    ) {
      return null
    }
    return new LongTaskWatch((onEntries) => {
      const po = new PerformanceObserver((list) => onEntries(list.getEntries()))
      po.observe({ type: 'longtask' })
      return po
    }, minMs)
  }

  /** For tests: a watch fed by hand (`feed`). */
  static manual(minMs = 50): LongTaskWatch & { feed(e: LongTaskEntry[]): void } {
    let sink: (e: LongTaskEntry[]) => void = () => {}
    const watch = new LongTaskWatch((onEntries) => {
      sink = onEntries
      return { disconnect: () => {} }
    }, minMs) as LongTaskWatch & { feed(e: LongTaskEntry[]): void }
    watch.feed = (e) => sink(e)
    return watch
  }

  /**
   * Whether a long task — at least `minMs` (default: the watch's own
   * threshold) — began at or after `t` (`performance.now()` time); forgets
   * the older ones.
   */
  since(t: number, minMs = 0): boolean {
    this.entries = this.entries.filter((e) => e.startTime >= t)
    return this.entries.some((e) => e.duration >= minMs)
  }

  disconnect(): void {
    this.observer.disconnect()
    this.entries = []
  }
}

/** Animation frames, for FrameGapWatch (tests hand their own). */
export interface FrameClock {
  request(cb: (t: number) => void): number
  cancel(handle: number): void
}

const windowFrames: FrameClock = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
}

/**
 * The frames the page missed while something watched for them: an
 * animation-frame interval longer than 1.5 display intervals is a gap,
 * reported by when it began (`since`, as LongTaskWatch reports a long task).
 * The display's interval is the shortest one seen in the last 120 frames
 * of this watch (a 60 Hz or a 120 Hz display alike; a page that draws a
 * frame a second whatever happens — software GL — has a long one). It runs only between `watch()` and
 * the moment the caller's `while` says no more — no frame loop when idle.
 */
export class FrameGapWatch {
  private gaps: number[] = []
  private recent: number[] = []
  private handle: number | null = null
  private last: number | null = null
  private keepWatching: () => boolean = () => false

  constructor(private readonly frames: FrameClock = windowFrames) {}

  /** The display's frame interval as seen (ms; 1000 / 60 before any frame). */
  get interval(): number {
    return this.recent.length < 2 ? 1000 / 60 : Math.min(...this.recent)
  }

  /**
   * How far apart this page's frames typically come (ms): the median of the
   * recent intervals, 1000 / 60 before three are known. Not the shortest, as
   * `interval` is: on a page that draws slowly whatever is asked of it
   * (software GL — SwiftShader in a VM, a blocklisted GPU) one quick frame
   * among second-long ones made the page look fast, the staging kept its
   * per-frame budget, and the off-screen tail of a crowded slide took 1.5 s a
   * text (e2e/text-runs-artboard.spec.ts at 400 %, 2026-10-31).
   */
  get typicalInterval(): number {
    if (this.recent.length < 3) return 1000 / 60
    const sorted = [...this.recent].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }

  /** Watch the frames for as long as `whileTrue()` holds (checked every frame). */
  watch(whileTrue: () => boolean): void {
    this.keepWatching = whileTrue
    if (this.handle !== null) return
    this.last = null
    // The display's interval as it is now, not as it was at the last staging.
    this.recent = []
    const tick = (t: number): void => {
      this.handle = null
      if (this.last !== null) {
        const dt = t - this.last
        this.recent.push(dt)
        if (this.recent.length > 120) this.recent.shift()
        if (dt > 1.5 * this.interval) this.gaps.push(this.last)
      }
      this.last = t
      if (this.keepWatching()) this.handle = this.frames.request(tick)
      else this.last = null
    }
    this.handle = this.frames.request(tick)
  }

  /** Whether a gap began at or after `t` (the frames' time base: `performance.now()`); forgets the older. */
  since(t: number): boolean {
    this.gaps = this.gaps.filter((g) => g >= t)
    return this.gaps.length > 0
  }

  stop(): void {
    if (this.handle !== null) this.frames.cancel(this.handle)
    this.handle = null
    this.last = null
    this.gaps = []
  }
}
