/**
 * stats.ts — summaries of a bench's runs and the verdict on two samples
 * (docs/plans/perf-harness.md → Measuring time precisely).
 *
 * - `summarize`: median, p90 and MAD (median absolute deviation, unscaled) —
 *   robust to the odd GC pause or compositor hitch that a mean would chase.
 * - `bootstrapMedianDiff`: the percentile-bootstrap confidence interval of
 *   median(b) − median(a), resampling each sample independently. The RNG is
 *   seeded (mulberry32), so the same samples always give the same interval —
 *   a verdict in a log can be reproduced from the stored samples.
 * - `compare`: regression / improvement / no-change. A difference is called
 *   only when the CI excludes zero AND the relative change of the medians
 *   exceeds the threshold; either alone is noise or irrelevance.
 *
 * Pure functions, no I/O: they run in Node and in the browser alike.
 */

export interface Summary {
  n: number
  median: number
  p90: number
  mad: number
  min: number
  max: number
  mean: number
}

function sorted(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b)
}

function assertSample(xs: readonly number[], what: string): void {
  if (xs.length === 0) throw new Error(`${what}: empty sample`)
  if (!xs.every(Number.isFinite)) throw new Error(`${what}: non-finite value in the sample`)
}

/** Quantile of an ascending array, linear interpolation between order statistics (R type 7). */
export function quantileSorted(asc: readonly number[], q: number): number {
  if (asc.length === 0) throw new Error('quantile of an empty sample')
  if (q < 0 || q > 1) throw new Error(`quantile ${q} is outside [0, 1]`)
  const h = (asc.length - 1) * q
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  const a = asc[lo]!
  return a + (asc[hi]! - a) * (h - lo)
}

export function quantile(xs: readonly number[], q: number): number {
  return quantileSorted(sorted(xs), q)
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5)
}

/** Median absolute deviation from the median (unscaled: × 1.4826 estimates σ of a normal). */
export function mad(xs: readonly number[]): number {
  const m = median(xs)
  return median(xs.map((x) => Math.abs(x - m)))
}

export function summarize(xs: readonly number[]): Summary {
  assertSample(xs, 'summarize')
  const asc = sorted(xs)
  return {
    n: asc.length,
    median: quantileSorted(asc, 0.5),
    p90: quantileSorted(asc, 0.9),
    mad: mad(asc),
    min: asc[0]!,
    max: asc[asc.length - 1]!,
    mean: asc.reduce((s, x) => s + x, 0) / asc.length,
  }
}

/** mulberry32: a small, fast, seedable PRNG with uniform output in [0, 1). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface DiffInterval {
  /** median(b) − median(a) of the samples themselves. */
  diff: number
  low: number
  high: number
  confidence: number
}

export interface BootstrapOptions {
  /** Resamples (default 10 000). */
  iterations?: number
  /** Default 0.95. */
  confidence?: number
  /** Default 0x5eed — fixed, so results are reproducible. */
  seed?: number
}

const DEFAULT_SEED = 0x5eed

function resampledMedian(asc: readonly number[], rand: () => number, buf: number[]): number {
  for (let i = 0; i < asc.length; i++) buf[i] = asc[Math.floor(rand() * asc.length)]!
  buf.sort((x, y) => x - y)
  return quantileSorted(buf, 0.5)
}

/** Percentile-bootstrap CI of median(b) − median(a). */
export function bootstrapMedianDiff(
  a: readonly number[],
  b: readonly number[],
  options: BootstrapOptions = {},
): DiffInterval {
  assertSample(a, 'bootstrap (a)')
  assertSample(b, 'bootstrap (b)')
  const iterations = options.iterations ?? 10_000
  const confidence = options.confidence ?? 0.95
  if (!(confidence > 0 && confidence < 1))
    throw new Error(`confidence ${confidence} is not in (0, 1)`)
  const rand = seededRandom(options.seed ?? DEFAULT_SEED)
  const ascA = sorted(a)
  const ascB = sorted(b)
  const bufA = new Array<number>(ascA.length)
  const bufB = new Array<number>(ascB.length)
  const diffs = new Array<number>(iterations)
  for (let i = 0; i < iterations; i++)
    diffs[i] = resampledMedian(ascB, rand, bufB) - resampledMedian(ascA, rand, bufA)
  diffs.sort((x, y) => x - y)
  const tail = (1 - confidence) / 2
  return {
    diff: quantileSorted(ascB, 0.5) - quantileSorted(ascA, 0.5),
    low: quantileSorted(diffs, tail),
    high: quantileSorted(diffs, 1 - tail),
    confidence,
  }
}

export type Verdict = 'regression' | 'improvement' | 'no-change'

export interface Comparison {
  verdict: Verdict
  /** Medians of a (base) and b (candidate). */
  base: number
  candidate: number
  /** Absolute interval of median(b) − median(a). */
  interval: DiffInterval
  /** (median(b) − median(a)) / |median(a)|; ±Infinity when a's median is 0 and b's is not. */
  relative: number
  threshold: number
  /** Why the verdict is what it is, in a few words. */
  reason: string
}

export interface CompareOptions extends BootstrapOptions {
  /** Default `lower` (a time, a counter). */
  better?: 'lower' | 'higher'
}

/**
 * Compare a base sample with a candidate. `threshold` is a fraction (0.05 =
 * 5 %): the relative change of the medians must exceed it, and the CI of the
 * median difference must exclude zero, for anything but no-change.
 */
export function compare(
  a: readonly number[],
  b: readonly number[],
  threshold: number,
  options: CompareOptions = {},
): Comparison {
  if (!(threshold >= 0 && threshold < 1)) throw new Error(`threshold ${threshold} is not in [0, 1)`)
  const interval = bootstrapMedianDiff(a, b, options)
  const base = median(a)
  const candidate = median(b)
  const relative =
    base === 0
      ? interval.diff === 0
        ? 0
        : Math.sign(interval.diff) * Infinity
      : interval.diff / Math.abs(base)
  const excludesZero = interval.low > 0 || interval.high < 0
  const beyond = Math.abs(relative) > threshold
  let verdict: Verdict = 'no-change'
  let reason: string
  if (!excludesZero) reason = 'the CI includes zero'
  else if (!beyond) reason = `within the ${(threshold * 100).toFixed(1)} % threshold`
  else {
    const worse = (options.better ?? 'lower') === 'lower' ? interval.diff > 0 : interval.diff < 0
    verdict = worse ? 'regression' : 'improvement'
    reason = 'the CI excludes zero and the change exceeds the threshold'
  }
  return { verdict, base, candidate, interval, relative, threshold, reason }
}

/** Runs of one bench: the values of each metric, in run order. */
export type Samples = Record<string, number[]>

export interface MeasureOptions {
  /** Unrecorded runs first (default 3): JIT, caches, texture uploads settle. */
  warmup?: number
  /** Recorded runs (default 15). */
  runs?: number
}

/**
 * Warm up, then run N times, collecting every metric the run returns. A run
 * that omits a declared metric, or returns an undeclared one, throws — a
 * silently missing value would bias the median.
 */
export async function measure(
  run: () => Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>,
  metrics: readonly string[],
  options: MeasureOptions = {},
): Promise<Samples> {
  const warmup = options.warmup ?? 3
  const runs = options.runs ?? 15
  if (runs < 1) throw new Error('measure: at least one run')
  for (let i = 0; i < warmup; i++) await run()
  const samples: Samples = Object.fromEntries(metrics.map((m) => [m, [] as number[]]))
  for (let i = 0; i < runs; i++) {
    const values = await run()
    const keys = Object.keys(values)
    const extra = keys.filter((k) => !metrics.includes(k))
    const missing = metrics.filter((m) => !keys.includes(m))
    if (extra.length > 0 || missing.length > 0)
      throw new Error(
        `measure: run ${i + 1} returned ${extra.length > 0 ? `undeclared [${extra.join(', ')}]` : ''}` +
          `${extra.length > 0 && missing.length > 0 ? ', ' : ''}${missing.length > 0 ? `no [${missing.join(', ')}]` : ''}`,
      )
    for (const m of metrics) {
      const v = values[m]!
      if (!Number.isFinite(v)) throw new Error(`measure: run ${i + 1}: ${m} = ${v}`)
      samples[m]!.push(v)
    }
  }
  return samples
}
