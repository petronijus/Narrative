// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AdaptiveBudget, FrameGapWatch, LongTaskWatch } from './restageBudget.js'

describe('AdaptiveBudget', () => {
  it('halves after a long task and grows by a quarter without one, within its bounds', () => {
    const b = new AdaptiveBudget(2_000_000, 250_000, 3_000_000)
    expect(b.value).toBe(2_000_000)
    expect(b.next(true)).toBe(1_000_000)
    expect(b.next(true)).toBe(500_000)
    expect(b.next(true)).toBe(250_000)
    expect(b.next(true)).toBe(250_000)
    expect(b.next(false)).toBe(312_500)
    for (let i = 0; i < 20; i++) b.next(false)
    expect(b.value).toBe(3_000_000)
  })

  it('starts within its bounds', () => {
    expect(new AdaptiveBudget(10, 100, 1000).value).toBe(100)
  })
})

describe('LongTaskWatch', () => {
  it('reports the long tasks that began at or after a time, and forgets the older', () => {
    const w = LongTaskWatch.manual(50)
    w.feed([
      { startTime: 100, duration: 120 }, // the commit, before the batch
      { startTime: 300, duration: 30 }, // not long
    ])
    expect(w.since(200)).toBe(false)
    w.feed([{ startTime: 450, duration: 80 }])
    expect(w.since(400)).toBe(true)
    expect(w.since(500)).toBe(false)
  })
})

describe('FrameGapWatch', () => {
  /** Frames by hand: `step(dt)` runs the pending callback `dt` ms after the last. */
  function clock() {
    let now = 0
    let pending: ((t: number) => void) | null = null
    return {
      request: (cb: (t: number) => void) => ((pending = cb), 1),
      cancel: () => void (pending = null),
      step(dt: number): boolean {
        now += dt
        const cb = pending
        pending = null
        cb?.(now)
        return cb !== null
      },
    }
  }

  it('reports a frame later than 1.5 display intervals, by when it began', () => {
    const c = clock()
    const w = new FrameGapWatch(c)
    w.watch(() => true)
    for (let i = 0; i < 10; i++) c.step(16.7)
    expect(w.since(0)).toBe(false)
    c.step(50) // begins at 167, lands at 217
    c.step(16.7)
    expect(w.since(160)).toBe(true)
    expect(w.since(200)).toBe(false)
  })

  it('takes a 120 Hz display as it is: a 16.7 ms frame there is a gap', () => {
    const c = clock()
    const w = new FrameGapWatch(c)
    w.watch(() => true)
    for (let i = 0; i < 10; i++) c.step(8.3)
    c.step(16.7)
    expect(w.since(0)).toBe(true)
  })

  it('stops asking for frames once the caller says no more', () => {
    const c = clock()
    const w = new FrameGapWatch(c)
    let left = 3
    w.watch(() => left-- > 0)
    expect(c.step(16.7)).toBe(true)
    expect(c.step(16.7)).toBe(true)
    expect(c.step(16.7)).toBe(true)
    expect(c.step(16.7)).toBe(true)
    // The fourth callback said no: nothing is pending any more.
    expect(c.step(16.7)).toBe(false)
    // A frame after a pause is not a gap: the watch starts over.
    w.watch(() => true)
    c.step(500)
    c.step(16.7)
    expect(w.since(0)).toBe(false)
  })
})

describe('FrameGapWatch on a slow page', () => {
  it('takes frames a second apart as the interval, not as gaps', () => {
    let now = 0
    const queue: Array<(t: number) => void> = []
    const w = new FrameGapWatch({
      request: (cb) => queue.push(cb),
      cancel: () => void queue.splice(0),
    })
    w.watch(() => true)
    for (let i = 0; i < 5; i++) {
      now += 1000
      queue.shift()?.(now)
    }
    expect(w.interval).toBe(1000)
    // The first frames, before an interval was known, may have counted; none after.
    expect(w.since(2000)).toBe(false)
  })

  it('is slow typically though one frame among them came quickly', () => {
    let now = 0
    const queue: Array<(t: number) => void> = []
    const w = new FrameGapWatch({
      request: (cb) => queue.push(cb),
      cancel: () => void queue.splice(0),
    })
    w.watch(() => true)
    expect(w.typicalInterval).toBeCloseTo(1000 / 60)
    for (const dt of [0, 900, 16, 1100, 950, 700]) {
      now += dt
      queue.shift()?.(now)
    }
    // The shortest (what a gap is measured against) is the quick one …
    expect(w.interval).toBe(16)
    // … the typical one is the page's pace.
    expect(w.typicalInterval).toBe(900)
  })

  it('is a display interval typically on a page that keeps up, a slow frame or two included', () => {
    let now = 0
    const queue: Array<(t: number) => void> = []
    const w = new FrameGapWatch({
      request: (cb) => queue.push(cb),
      cancel: () => void queue.splice(0),
    })
    w.watch(() => true)
    for (const dt of [0, 16.7, 16.7, 83, 16.7, 100, 16.7, 16.7]) {
      now += dt
      queue.shift()?.(now)
    }
    expect(w.typicalInterval).toBeCloseTo(16.7)
  })
})

describe('LongTaskWatch with a threshold', () => {
  it('counts only the tasks at least as long as asked', () => {
    const w = LongTaskWatch.manual(50)
    w.feed([{ startTime: 10, duration: 900 }])
    expect(w.since(0, 1500)).toBe(false)
    w.feed([{ startTime: 20, duration: 1600 }])
    expect(w.since(0, 1500)).toBe(true)
  })
})
