import { describe, expect, it } from 'vitest'
import { mapConcurrent, WeightedSemaphore } from './concurrency.js'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('mapConcurrent', () => {
  it('returns results in input order, whatever order the calls finish in', async () => {
    const delays = [30, 5, 20, 1, 10, 0]
    const out = await mapConcurrent(delays, 3, async (ms, i) => {
      await tick(ms)
      return `${i}:${ms}`
    })
    expect(out).toEqual(delays.map((ms, i) => `${i}:${ms}`))
  })

  it('never has more than `limit` calls in flight, and uses all of them', async () => {
    let inFlight = 0
    let peak = 0
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (i) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await tick(i % 3)
        inFlight--
      },
    )
    expect(peak).toBe(4)
  })

  it('stops starting calls after a failure, waits for the running ones, rejects with the first error', async () => {
    const started: number[] = []
    let finished = 0
    const run = mapConcurrent([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i)
      await tick(5)
      finished++
      if (i === 1) throw new Error('first')
      if (i === 2) throw new Error('second')
      return i
    })
    await expect(run).rejects.toThrow('first')
    // 0 and 1 ran together; 1 failed, so at most the call that took 0's slot started.
    expect(started.length).toBeLessThanOrEqual(3)
    expect(finished).toBe(started.length)
  })

  it('handles an empty list and refuses a limit below one', async () => {
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([])
    await expect(mapConcurrent([1], 0, async () => 1)).rejects.toThrow(RangeError)
  })
})

describe('WeightedSemaphore', () => {
  it('keeps the weight in flight within capacity, serving waiters in arrival order', async () => {
    const sem = new WeightedSemaphore(10)
    let inUse = 0
    let peak = 0
    const order: number[] = []
    const task = (w: number, i: number): Promise<void> =>
      sem.run(w, async () => {
        order.push(i)
        inUse += w
        peak = Math.max(peak, inUse)
        await tick(5)
        inUse -= w
      })
    await Promise.all([task(6, 0), task(6, 1), task(3, 2), task(4, 3)])
    expect(peak).toBeLessThanOrEqual(10)
    // 1 waits for 0; 2 and 3 queue behind 1 rather than overtaking it.
    expect(order).toEqual([0, 1, 2, 3])
  })

  it('runs a task heavier than the capacity alone instead of never', async () => {
    const sem = new WeightedSemaphore(10)
    const running = new Set<string>()
    const seen: string[][] = []
    const task = (name: string, w: number): Promise<void> =>
      sem.run(w, async () => {
        running.add(name)
        seen.push([...running])
        await tick(5)
        running.delete(name)
      })
    await Promise.all([task('a', 4), task('huge', 25), task('b', 4)])
    expect(seen.find((s) => s.includes('huge'))).toEqual(['huge'])
  })

  it('releases its share when the task throws', async () => {
    const sem = new WeightedSemaphore(5)
    await expect(sem.run(5, () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(await sem.run(5, async () => 'ok')).toBe('ok')
  })
})
