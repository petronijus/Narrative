// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  BatchStager,
  rectDistance,
  stagingOrder,
  widenRect,
  type FrameSource,
  type IdleSource,
  type StagedJob,
  type Rect,
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
