// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  animationFrames,
  BatchStager,
  FRAME_FALLBACK_MS,
  planTextResolutions,
  rectDistance,
  stagingOrder,
  widenRect,
  type FrameSource,
  type IdleSource,
  type StagedJob,
  type Rect,
  type ResolutionPlanItem,
} from './textResolutionStaging.js'

/** Frames that run only when the test says so. */
function manualFrames(): FrameSource & { flush: () => void; readonly queued: number } {
  let next = 1
  const pending = new Map<number, () => void>()
  return {
    request(cb) {
      const handle = next++
      pending.set(handle, cb)
      return handle
    },
    cancel(handle) {
      pending.delete(handle)
    },
    flush() {
      const due = [...pending.values()]
      pending.clear()
      for (const cb of due) cb()
    },
    get queued() {
      return pending.size
    },
  }
}

/** Idle callbacks that run only when the test says so; records each timeout asked for. */
function manualIdle(): IdleSource & {
  flush: () => void
  readonly queued: number
  timeouts: number[]
} {
  const frames = manualFrames()
  const timeouts: number[] = []
  return {
    request(cb, timeout) {
      timeouts.push(timeout)
      return frames.request(cb)
    },
    cancel: (handle) => frames.cancel(handle),
    flush: () => frames.flush(),
    get queued() {
      return frames.queued
    },
    timeouts,
  }
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
})

describe('widenRect', () => {
  it('grows the rect about its centre by the fraction of its size', () => {
    expect(widenRect(rect(100, 200, 400, 200), 0.25)).toEqual(rect(50, 175, 500, 250))
  })
})

describe('rectDistance', () => {
  it('is 0 for rects that overlap or touch', () => {
    expect(rectDistance(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(0)
    expect(rectDistance(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(0)
  })
  it('is the gap between them, diagonally too', () => {
    expect(rectDistance(rect(0, 0, 10, 10), rect(30, 0, 5, 5))).toBe(20)
    expect(rectDistance(rect(0, 0, 10, 10), rect(13, 14, 5, 5))).toBe(5)
  })
})

describe('stagingOrder', () => {
  const viewport = rect(0, 0, 100, 100)
  const boxes: Record<string, Rect | null> = {
    far: rect(1000, 0, 10, 10),
    in1: rect(10, 10, 10, 10),
    near: rect(150, 0, 10, 10),
    none: null,
    in2: rect(90, 90, 50, 50),
  }
  const boxOf = (id: string): Rect | null => boxes[id] ?? null

  it('puts what meets the viewport first, then the rest nearest first, the unplaced last', () => {
    expect(stagingOrder(['far', 'in1', 'near', 'none', 'in2'], boxOf, viewport)).toEqual([
      'in1',
      'in2',
      'near',
      'far',
      'none',
    ])
  })

  it('keeps the scene order without a viewport', () => {
    expect(stagingOrder(['far', 'in1', 'none'], boxOf, null)).toEqual(['far', 'in1', 'none'])
  })
})

describe('BatchStager', () => {
  const jobs = (log: number[], n: number, from = 0): StagedJob[] =>
    Array.from({ length: n }, (_, i) => () => {
      log.push(from + i)
      return { cost: 1 }
    })
  /** A job that logs its id and costs `cost` (null: found nothing to do). */
  const job =
    (ran: string[], id: string, cost: number | null, settled?: () => boolean): StagedJob =>
    () => {
      ran.push(id)
      if (cost === null) return null
      return settled === undefined ? { cost } : { cost, settled }
    }

  it('runs the first batch at once and one batch per frame after it', () => {
    const frames = manualFrames()
    const onBatch = vi.fn()
    const stager = new BatchStager({ maxJobs: 8, frames, onBatch })
    const log: number[] = []
    stager.stage(jobs(log, 20))
    expect(log).toHaveLength(8)
    expect(stager.pending).toBe(12)
    frames.flush()
    expect(log).toHaveLength(16)
    frames.flush()
    expect(log).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(stager.pending).toBe(0)
    expect(frames.queued).toBe(0)
    expect(onBatch).toHaveBeenCalledTimes(3)
  })

  it('gives a job that did nothing no batch slot', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 2, frames })
    const ran: string[] = []
    stager.stage([
      job(ran, 'a', null),
      job(ran, 'b', 1),
      job(ran, 'c', null),
      job(ran, 'd', 1),
      job(ran, 'e', 1),
    ])
    expect(ran).toEqual(['a', 'b', 'c', 'd'])
    frames.flush()
    expect(ran).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('ends a batch at its budget, the job crossing it included', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 8, budget: 10, frames })
    const ran: string[] = []
    stager.stage([
      job(ran, 'a', 4),
      job(ran, 'b', 4),
      job(ran, 'c', 4),
      job(ran, 'huge', 50),
      job(ran, 'd', 1),
    ])
    expect(ran).toEqual(['a', 'b', 'c'])
    frames.flush()
    // One job over the whole budget still gets a frame of its own.
    expect(ran).toEqual(['a', 'b', 'c', 'huge'])
    frames.flush()
    expect(ran).toEqual(['a', 'b', 'c', 'huge', 'd'])
  })

  it('does not ask for a render after a batch that did nothing', () => {
    const onBatch = vi.fn()
    const stager = new BatchStager({ maxJobs: 4, frames: manualFrames(), onBatch })
    stager.stage([() => null, () => null])
    expect(onBatch).not.toHaveBeenCalled()
  })

  it('waits for the previous batch to settle before the next', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 1, maxWaitFrames: 10, frames })
    const ran: string[] = []
    let landed = false
    stager.stage([job(ran, 'a', 1, () => landed), job(ran, 'b', 1)])
    frames.flush()
    frames.flush()
    expect(ran).toEqual(['a'])
    landed = true
    frames.flush()
    expect(ran).toEqual(['a', 'b'])
    expect(frames.queued).toBe(0)
  })

  it('stops waiting after maxWaitFrames (work that never renders cannot stall it)', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 1, maxWaitFrames: 2, frames })
    const ran: string[] = []
    stager.stage([job(ran, 'hidden', 1, () => false), job(ran, 'b', 1)])
    frames.flush()
    frames.flush()
    expect(ran).toEqual(['hidden'])
    frames.flush()
    expect(ran).toEqual(['hidden', 'b'])
  })

  it('a newer staging replaces the older one: none of its jobs run afterwards', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 3, frames })
    const log: number[] = []
    stager.stage(jobs(log, 9, 0))
    stager.stage(jobs(log, 4, 100))
    expect(frames.queued).toBe(1)
    frames.flush()
    frames.flush()
    expect(log).toEqual([0, 1, 2, 100, 101, 102, 103])
  })

  it('a newer staging does not wait for the older one to settle', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 1, maxWaitFrames: 10, frames })
    const ran: string[] = []
    stager.stage([job(ran, 'old', 1, () => false), job(ran, 'old2', 1)])
    stager.stage([job(ran, 'new', 1), job(ran, 'new2', 1)])
    frames.flush()
    expect(ran).toEqual(['old', 'new', 'new2'])
  })

  it('runs the deferred tail in idle callbacks, after the jobs before it', () => {
    const frames = manualFrames()
    const idle = manualIdle()
    const stager = new BatchStager({ maxJobs: 2, frames, idle, idleTimeout: 700 })
    const log: number[] = []
    stager.stage(jobs(log, 7), { deferFrom: 3 })
    // The first batch at once, then frames up to the deferred part (a batch never spans both).
    expect(log).toEqual([0, 1])
    expect(idle.queued).toBe(0)
    frames.flush()
    expect(log).toEqual([0, 1, 2])
    expect(frames.queued).toBe(0)
    expect(idle.queued).toBe(1)
    idle.flush()
    expect(log).toEqual([0, 1, 2, 3, 4])
    idle.flush()
    idle.flush()
    expect(log).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(stager.pending).toBe(0)
    expect(idle.timeouts.every((t) => t === 700)).toBe(true)
  })

  it('waits for a deferred batch to settle a frame at a time, not an idle callback at a time', () => {
    const frames = manualFrames()
    const idle = manualIdle()
    const stager = new BatchStager({ maxJobs: 1, maxWaitFrames: 10, frames, idle })
    const ran: string[] = []
    let landed = false
    stager.stage([job(ran, 'a', 1, () => landed), job(ran, 'b', 1)], { deferFrom: 0 })
    idle.flush()
    expect(ran).toEqual(['a'])
    // The next batch's turn: 'a' has not landed — the wait is a frame.
    idle.flush()
    expect(idle.queued).toBe(0)
    expect(frames.queued).toBe(1)
    landed = true
    frames.flush()
    expect(ran).toEqual(['a', 'b'])
  })

  it('with everything deferred, nothing runs in the stage() call', () => {
    const frames = manualFrames()
    const idle = manualIdle()
    const stager = new BatchStager({ maxJobs: 4, frames, idle })
    const log: number[] = []
    stager.stage(jobs(log, 2), { deferFrom: 0 })
    expect(log).toEqual([])
    idle.flush()
    expect(log).toEqual([0, 1])
  })

  it('pause keeps what is left, unscheduled; resume goes on from there', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 2, frames })
    const log: number[] = []
    stager.stage(jobs(log, 6))
    stager.pause()
    expect(stager.paused).toBe(true)
    expect(frames.queued).toBe(0)
    frames.flush()
    expect(log).toEqual([0, 1])
    stager.resume()
    frames.flush()
    expect(log).toEqual([0, 1, 2, 3])
    frames.flush()
    expect(log).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('a new staging ends a pause; resume with nothing left schedules nothing', () => {
    const frames = manualFrames()
    const stager = new BatchStager({ maxJobs: 1, frames })
    const log: number[] = []
    stager.stage(jobs(log, 1))
    stager.pause()
    stager.resume()
    expect(frames.queued).toBe(0)
    stager.pause()
    stager.stage(jobs(log, 2, 10))
    expect(stager.paused).toBe(false)
    expect(log).toEqual([0, 10])
    frames.flush()
    expect(log).toEqual([0, 10, 11])
  })

  it('asks a budget function at the start of every batch', () => {
    const frames = manualFrames()
    let budget = 2
    const stager = new BatchStager({ maxJobs: 8, budget: () => budget, frames })
    const ran: string[] = []
    stager.stage(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => job(ran, id, 1)))
    expect(ran).toEqual(['a', 'b'])
    budget = 3
    frames.flush()
    expect(ran).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('a frame of a cancelled staging that still fires does nothing', () => {
    // A frame source whose cancel is lost (the callback was already due).
    let due: (() => void) | null = null
    const leaky: FrameSource = {
      request: (cb) => {
        due = cb
        return 1
      },
      cancel: () => {},
    }
    const stager = new BatchStager({ maxJobs: 1, frames: leaky })
    const log: number[] = []
    stager.stage(jobs(log, 3))
    const stale = due!
    stager.cancel()
    stale()
    expect(log).toEqual([0])
    expect(stager.pending).toBe(0)
  })
})

describe('animationFrames', () => {
  /**
   * The window's frames, faked: `frame()` runs the frames requested so far
   * (a cancelled one does not run), `stale` keeps every callback ever handed
   * over — a browser may still deliver a frame it was asked to cancel too late.
   */
  function fakeWindowFrames(): {
    frame: () => void
    readonly requested: number
    stale: FrameRequestCallback[]
  } {
    let next = 1
    const pending = new Map<number, FrameRequestCallback>()
    const stale: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.set(next, cb)
      stale.push(cb)
      return next++
    })
    vi.stubGlobal('cancelAnimationFrame', (h: number) => pending.delete(h))
    return {
      frame() {
        const due = [...pending.values()]
        pending.clear()
        for (const cb of due) cb(performance.now())
      },
      get requested() {
        return pending.size
      },
      stale,
    }
  }

  const withFakes = (body: (w: ReturnType<typeof fakeWindowFrames>) => void): void => {
    vi.useFakeTimers()
    try {
      body(fakeWindowFrames())
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  }

  it('runs a request on the next frame, once, and drops its fallback timer', () =>
    withFakes((w) => {
      const ran: string[] = []
      animationFrames.request(() => ran.push('framed'))
      expect(vi.getTimerCount()).toBe(1)
      w.frame()
      expect(ran).toEqual(['framed'])
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(FRAME_FALLBACK_MS * 2)
      expect(ran).toEqual(['framed'])
    }))

  it('runs a request after FRAME_FALLBACK_MS when no frame comes, and not again on a late frame', () =>
    withFakes((w) => {
      const ran: string[] = []
      animationFrames.request(() => ran.push('no frame'))
      vi.advanceTimersByTime(FRAME_FALLBACK_MS - 1)
      expect(ran).toEqual([])
      vi.advanceTimersByTime(1)
      expect(ran).toEqual(['no frame'])
      // The frame was cancelled when the timer won …
      expect(w.requested).toBe(0)
      // … and one the browser delivers anyway does nothing.
      for (const cb of w.stale) cb(performance.now())
      expect(ran).toEqual(['no frame'])
    }))

  it('cancel drops both the frame and the timer; a cancel after it ran is harmless', () =>
    withFakes((w) => {
      const ran: string[] = []
      const h = animationFrames.request(() => ran.push('cancelled'))
      animationFrames.cancel(h)
      expect(w.requested).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(FRAME_FALLBACK_MS * 2)
      w.frame()
      expect(ran).toEqual([])
      const done = animationFrames.request(() => ran.push('ran'))
      w.frame()
      animationFrames.cancel(done)
      expect(ran).toEqual(['ran'])
    }))

  it('a staging on the window frames finishes in a page that draws no frames at all', () =>
    withFakes((w) => {
      const onBatch = vi.fn()
      const stager = new BatchStager({ maxJobs: 2, maxWaitFrames: 3, onBatch })
      const ran: number[] = []
      // Rasters that never land without a frame: each wait gives up after maxWaitFrames.
      const never: StagedJob[] = Array.from({ length: 6 }, (_, i) => () => {
        ran.push(i)
        return { cost: 1, settled: () => false }
      })
      stager.stage(never)
      expect(ran).toEqual([0, 1])
      // Two batches left, each behind three waits and its own frame: four fallbacks a batch.
      vi.advanceTimersByTime(FRAME_FALLBACK_MS * 4)
      expect(ran).toEqual([0, 1, 2, 3])
      vi.advanceTimersByTime(FRAME_FALLBACK_MS * 4)
      expect(ran).toEqual([0, 1, 2, 3, 4, 5])
      expect(stager.pending).toBe(0)
      expect(onBatch).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
      expect(w.requested).toBe(0)
    }))

  it('frames that do come drive the staging; the fallback adds no batch of its own', () =>
    withFakes((w) => {
      const stager = new BatchStager({ maxJobs: 1 })
      const log: number[] = []
      stager.stage(
        [0, 1, 2].map((i) => () => {
          log.push(i)
          return { cost: 1 }
        }),
      )
      w.frame()
      w.frame()
      expect(log).toEqual([0, 1, 2])
      vi.advanceTimersByTime(FRAME_FALLBACK_MS * 4)
      expect(log).toEqual([0, 1, 2])
      expect(vi.getTimerCount()).toBe(0)
    }))
})

describe("planTextResolutions (the zoom staging's targets, ADR 0020 → texture memory)", () => {
  const viewport: Rect = { x: 0, y: 0, width: 100, height: 100 }
  const marginRect: Rect = { x: -25, y: -25, width: 150, height: 150 }
  const box = (x: number, y: number): Rect => ({ x, y, width: 10, height: 10 })
  const item = (b: Rect | null, px: number, now = 1): ResolutionPlanItem => ({ box: b, now, px })
  /** Target per input index. */
  const byIndex = (p: ReturnType<typeof planTextResolutions>): number[] => {
    const out: number[] = []
    p.order.forEach((k, i) => (out[k] = p.targets[i]!))
    return out
  }

  it('gives the view the full resolution whatever it costs, the margin while the budget lasts', () => {
    const items = [
      item(box(-20, 0), 30), // margin, nearest
      item(box(50, 50), 100), // in view
      item(box(-24, -24), 30), // margin, farther
      item(box(500, 0), 30), // far
    ]
    const p = planTextResolutions(items, 5, viewport, { rect: marginRect, budgetPx: 120 }, 2)
    // In view first (over the budget alone), then the margin nearest first: none fits.
    expect(p.order).toEqual([1, 0, 2, 3])
    expect(byIndex(p)).toEqual([2, 5, 2, 2])
    expect(p.deferFrom).toBe(1)
    const roomy = planTextResolutions(items, 5, viewport, { rect: marginRect, budgetPx: 145 }, 2)
    expect(byIndex(roomy)).toEqual([5, 5, 2, 2])
    expect(roomy.deferFrom).toBe(2)
  })

  it('is the old staging with an unlimited budget: margin full, the rest kept or capped', () => {
    const items = [item(box(-20, 0), 30), item(box(500, 0), 30, 4), item(box(600, 0), 30, 8)]
    const p = planTextResolutions(items, 5, viewport, { rect: marginRect, budgetPx: Infinity }, 2)
    // Far: a raster between the cap and the resolution is kept, one above it comes down.
    expect(byIndex(p)).toEqual([5, 4, 2])
  })

  it('takes texts a scroll left down to the cap once the budget is spent', () => {
    // Two far texts still at full resolution from an earlier view, nearest first.
    const items = [item(box(50, 50), 60, 5), item(box(300, 0), 30, 5), item(box(200, 0), 30, 5)]
    const p = planTextResolutions(items, 5, viewport, { rect: marginRect, budgetPx: 100 }, 2)
    expect(byIndex(p)).toEqual([5, 2, 5])
  })

  it('costs a kept raster at its own resolution', () => {
    const items = [item(box(300, 0), 100, 2.5)]
    // 100 px at 5 is 25 px at 2.5: within a budget of 30.
    expect(
      byIndex(planTextResolutions(items, 5, viewport, { rect: marginRect, budgetPx: 30 }, 2)),
    ).toEqual([2.5])
  })

  it('gives every text the resolution without a viewport, or when the cap is above it', () => {
    const items = [item(box(500, 0), 1e9), item(null, 1e9)]
    expect(byIndex(planTextResolutions(items, 5, null, null, 2))).toEqual([5, 5])
    expect(
      byIndex(planTextResolutions(items, 1.5, viewport, { rect: marginRect, budgetPx: 1 }, 2)),
    ).toEqual([1.5, 1.5])
  })

  it('without a margin, holds everything beyond the view to the cap', () => {
    const items = [item(box(-20, 0), 1), item(null, 1, 0)]
    const p = planTextResolutions(items, 5, viewport, null, 2)
    expect(byIndex(p)).toEqual([2, 2])
    expect(p.deferFrom).toBe(0)
  })
})
