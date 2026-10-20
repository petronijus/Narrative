import { describe, expect, it } from 'vitest'
import { AdaptiveBudget, LongTaskWatch } from './restageBudget.js'

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
