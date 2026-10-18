import { describe, expect, it } from 'vitest'
import {
  bootstrapMedianDiff,
  compare,
  mad,
  measure,
  median,
  quantile,
  seededRandom,
  summarize,
} from './stats.js'

/** n draws of a normal(mu, sigma) from a seeded Box–Muller. */
function normal(n: number, mu: number, sigma: number, seed: number): number[] {
  const rand = seededRandom(seed)
  return Array.from({ length: n }, () => {
    const u = 1 - rand()
    const v = rand()
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  })
}

describe('summaries', () => {
  it('median, quantiles and MAD of known samples', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1)
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1)
    const s = summarize([10, 12, 11, 13, 100])
    expect(s).toMatchObject({ n: 5, median: 12, min: 10, max: 100, mad: 1 })
    expect(s.mean).toBeCloseTo(29.2)
  })

  it('the median and MAD of a large normal sample estimate mu and sigma', () => {
    const xs = normal(20_000, 50, 4, 7)
    expect(median(xs)).toBeCloseTo(50, 0)
    expect(mad(xs) * 1.4826).toBeCloseTo(4, 0)
  })

  it('refuses empty or non-finite samples', () => {
    expect(() => summarize([])).toThrow(/empty/)
    expect(() => summarize([1, Number.NaN])).toThrow(/non-finite/)
  })
})

describe('the seeded RNG', () => {
  it('is reproducible and roughly uniform', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    const xs = Array.from({ length: 10_000 }, () => a())
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThan(1)
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1)
  })
})

describe('the bootstrap CI of the median difference', () => {
  it('is the same for the same samples and seed', () => {
    const a = normal(15, 10, 1, 1)
    const b = normal(15, 11, 1, 2)
    expect(bootstrapMedianDiff(a, b)).toEqual(bootstrapMedianDiff(a, b))
    expect(bootstrapMedianDiff(a, b, { seed: 9 })).not.toEqual(bootstrapMedianDiff(a, b))
  })

  it('covers the true shift of two normals', () => {
    const a = normal(15, 100, 3, 11)
    const b = normal(15, 110, 3, 12)
    const ci = bootstrapMedianDiff(a, b)
    expect(ci.low).toBeLessThan(10)
    expect(ci.high).toBeGreaterThan(10)
    expect(ci.low).toBeGreaterThan(0)
  })

  it('includes zero for two samples of one distribution', () => {
    const ci = bootstrapMedianDiff(normal(15, 100, 3, 21), normal(15, 100, 3, 22))
    expect(ci.low).toBeLessThan(0)
    expect(ci.high).toBeGreaterThan(0)
  })

  it('collapses to the difference for constant samples', () => {
    expect(bootstrapMedianDiff([4, 4, 4], [7, 7, 7])).toMatchObject({ diff: 3, low: 3, high: 3 })
  })
})

describe('compare', () => {
  it('calls a regression only when the CI excludes zero and the change exceeds the threshold', () => {
    const base = normal(15, 100, 2, 31)
    const slower = normal(15, 115, 2, 32)
    const r = compare(base, slower, 0.05)
    expect(r.verdict).toBe('regression')
    expect(r.relative).toBeGreaterThan(0.1)
    expect(compare(slower, base, 0.05).verdict).toBe('improvement')
  })

  it('a real but small change within the threshold is no change', () => {
    const base = normal(30, 100, 0.5, 41)
    const r = compare(base, normal(30, 102, 0.5, 42), 0.05)
    expect(r.interval.low).toBeGreaterThan(0) // the CI excludes zero …
    expect(r.verdict).toBe('no-change') // … but 2 % < 5 %
    expect(r.reason).toMatch(/threshold/)
  })

  it('a large but noisy change whose CI includes zero is no change', () => {
    const r = compare([10, 50, 12, 48, 11], [14, 52, 13, 49, 60], 0.05)
    expect(r.interval.low).toBeLessThanOrEqual(0)
    expect(r.verdict).toBe('no-change')
    expect(r.reason).toMatch(/includes zero/)
  })

  it('reads higher-is-better metrics the other way', () => {
    expect(compare([60, 60, 60], [30, 30, 30], 0.05, { better: 'higher' }).verdict).toBe(
      'regression',
    )
  })

  it('a count growing from zero is an infinite relative change', () => {
    const r = compare([0, 0, 0], [120, 120, 120], 0.05)
    expect(r.relative).toBe(Infinity)
    expect(r.verdict).toBe('regression')
    expect(compare([0, 0], [0, 0], 0.05).relative).toBe(0)
  })
})

describe('measure', () => {
  it('warms up, then records every declared metric of each run', async () => {
    let i = 0
    const samples = await measure(() => ({ ms: ++i, count: 3 }), ['ms', 'count'], {
      warmup: 2,
      runs: 4,
    })
    expect(samples).toEqual({ ms: [3, 4, 5, 6], count: [3, 3, 3, 3] })
  })

  it('refuses a run that omits or adds a metric', async () => {
    await expect(measure(() => ({ ms: 1 }), ['ms', 'count'], { warmup: 0 })).rejects.toThrow(
      /no \[count\]/,
    )
    await expect(measure(() => ({ ms: 1, x: 2 }), ['ms'], { warmup: 0 })).rejects.toThrow(
      /undeclared \[x\]/,
    )
  })
})
