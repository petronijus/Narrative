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

  /** Whether a long task began at or after `t` (`performance.now()` time); forgets the older ones. */
  since(t: number): boolean {
    this.entries = this.entries.filter((e) => e.startTime >= t)
    return this.entries.length > 0
  }

  disconnect(): void {
    this.observer.disconnect()
    this.entries = []
  }
}
