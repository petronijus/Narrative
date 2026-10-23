/**
 * result.ts — one bench run as it is stored (results.jsonl), compared and
 * printed, and the function that produces it.
 */

import {
  metricsFor,
  thresholdOf,
  workMetricsFor,
  type BenchDef,
  type Layer,
} from './defineBench.js'
import { guarded, type DiscardedRun, type RunGuard } from './disturbance.js'
import type { Fingerprint } from './fingerprint.js'
import {
  compare,
  measure,
  summarize,
  type Comparison,
  type MeasureOptions,
  type Samples,
  type Summary,
} from './stats.js'

export const RESULT_FORMAT = 1

export interface BenchResult {
  format: typeof RESULT_FORMAT
  benchId: string
  layer: Layer
  /** ISO time the run finished. */
  at: string
  fingerprint: Fingerprint
  warmup: number
  runs: number
  /** Every recorded run's values, per metric (the bootstrap needs them, not just summaries). */
  samples: Samples
  summary: Record<string, Summary>
  /**
   * The work metrics of the run, when they did not vary between runs — the
   * counter snapshot. Only those the runtime counts exactly
   * (`workMetricsFor`): a `perFrame` count of a display-paced run is a time
   * metric there, in `samples` only.
   */
  counters?: Record<string, number>
  /**
   * The attempts that were disturbed (a network change: disturbance.ts) and
   * run again; absent when none was. `samples` hold only the undisturbed
   * attempts — this says a run needed retries, and what disturbed it.
   * Optional, so results stored before it (format 1 all the same) read as
   * "none discarded".
   */
  discarded?: DiscardedRun[]
}

/** `runBench` / `runInterleaved` options: the runs, and the guard that discards a disturbed one. */
export interface RunOptions extends MeasureOptions {
  guard?: RunGuard
}

/**
 * The stored result of `samples` recorded for `def` under `fingerprint`:
 * summaries, and the counter snapshot of its work metrics — which must not
 * have varied between runs. Which metrics are work is the fingerprint's
 * question as much as the bench's (`metricsFor`: a `perFrame` count is timed
 * where the runtime does not draw a frame per input).
 */
export function resultFrom(
  def: Pick<BenchDef<never>, 'id' | 'layer' | 'metrics'>,
  samples: Samples,
  fingerprint: Fingerprint,
  warmup: number,
  runs: number,
): BenchResult {
  const names = Object.keys(def.metrics)
  const summary = Object.fromEntries(names.map((m) => [m, summarize(samples[m]!)]))
  const exact = new Set(workMetricsFor(def.metrics, fingerprint))
  const work = names.filter((m) => exact.has(m))
  const unstable = work.filter((m) => new Set(samples[m]).size > 1)
  if (unstable.length > 0)
    throw new Error(
      `${def.id}: work metrics varied between runs (${unstable
        .map((m) => `${m} ${samples[m]!.join('/')}`)
        .join(', ')}): a work count must be deterministic — ` +
        'declare it as kind "time" (or perFrame, when it counts once-a-frame work) or fix what makes it vary',
    )
  const result: BenchResult = {
    format: RESULT_FORMAT,
    benchId: def.id,
    layer: def.layer,
    at: new Date().toISOString(),
    fingerprint,
    warmup,
    runs,
    samples,
    summary,
  }
  if (work.length > 0) result.counters = Object.fromEntries(work.map((m) => [m, samples[m]![0]!]))
  return result
}

/** Run a bench: warm-up, N runs, summaries, and the counter snapshot of its work metrics. */
export async function runBench<Ctx>(
  def: BenchDef<Ctx>,
  ctx: Ctx,
  fingerprint: Fingerprint,
  options: RunOptions = {},
): Promise<BenchResult> {
  const warmup = options.warmup ?? 3
  const runs = options.runs ?? 15
  const names = Object.keys(def.metrics)
  const discarded: DiscardedRun[] = []
  let warm = 0
  let recorded = 0
  // measure() calls the run warm-ups first, then the recorded runs, in order.
  const samples = await measure(
    () => {
      const slot =
        warm < warmup
          ? { phase: 'warmup' as const, index: ++warm }
          : { phase: 'run' as const, index: ++recorded }
      return guarded(def.id, async () => def.run(ctx), options.guard, slot, discarded)
    },
    names,
    { warmup, runs },
  )
  const result = resultFrom(def as BenchDef<never>, samples, fingerprint, warmup, runs)
  if (discarded.length > 0) result.discarded = discarded
  return result
}

/** One side of an interleaved run: its context and the fingerprint its results carry. */
export interface Side<Ctx> {
  name: string
  ctx: Ctx
  fingerprint: Fingerprint
}

/**
 * Run a bench on several sides interleaved — A B A B … (perf-harness.md →
 * Design principles 4: both revisions in the same minute, so a drift of the
 * machine lands on both). Warm-ups interleave the same way. One result per
 * side, in the order given.
 */
export async function runInterleaved<Ctx>(
  def: BenchDef<Ctx>,
  sides: ReadonlyArray<Side<Ctx>>,
  options: RunOptions = {},
): Promise<BenchResult[]> {
  const warmup = options.warmup ?? 3
  const runs = options.runs ?? 15
  const names = Object.keys(def.metrics)
  const samples = sides.map(() => Object.fromEntries(names.map((m) => [m, [] as number[]])))
  const discarded = sides.map((): DiscardedRun[] => [])
  const once = (
    k: number,
    phase: 'warmup' | 'run',
    index: number,
  ): Promise<Record<string, number>> => {
    const side = sides[k]!
    // A disturbed attempt (options.guard) is discarded and run again, its
    // side's turn kept: A B A B stays interleaved.
    return guarded(
      def.id,
      async () => {
        const values = await def.run(side.ctx)
        const extra = Object.keys(values).filter((k) => !names.includes(k))
        if (extra.length > 0)
          throw new Error(
            `${def.id} on ${side.name}: run returned undeclared [${extra.join(', ')}]`,
          )
        for (const m of names)
          if (typeof values[m] !== 'number' || !Number.isFinite(values[m]))
            throw new Error(`${def.id} on ${side.name}: run returned no number for metric '${m}'`)
        return values as Record<string, number>
      },
      options.guard,
      { side: side.name, phase, index },
      discarded[k]!,
    )
  }
  for (let i = 0; i < warmup; i++) for (const k of sides.keys()) await once(k, 'warmup', i + 1)
  for (let i = 0; i < runs; i++)
    for (const k of sides.keys()) {
      const values = await once(k, 'run', i + 1)
      for (const m of names) samples[k]![m]!.push(values[m]!)
    }
  return sides.map((side, k) => {
    const result = resultFrom(def as BenchDef<never>, samples[k]!, side.fingerprint, warmup, runs)
    if (discarded[k]!.length > 0) result.discarded = discarded[k]!
    return result
  })
}

export interface MetricComparison extends Comparison {
  metric: string
  unit: string
}

/** Compare every time metric two results of one bench share (work metrics go to the budgets; `metricsFor` decides which are time). */
export function compareResults(
  def: Pick<BenchDef<never>, 'id' | 'metrics' | 'threshold'>,
  base: BenchResult,
  candidate: BenchResult,
): MetricComparison[] {
  if (base.benchId !== def.id || candidate.benchId !== def.id)
    throw new Error(
      `compareResults: results of ${base.benchId} / ${candidate.benchId}, not ${def.id}`,
    )
  // A metric is timed when either side's runtime times it (two comparable
  // results share their runtime, so in practice both or neither).
  const onBase = metricsFor(def.metrics, base.fingerprint)
  const onCandidate = metricsFor(def.metrics, candidate.fingerprint)
  return Object.entries(def.metrics)
    .filter(
      ([m]) =>
        (onBase[m]!.kind === 'time' || onCandidate[m]!.kind === 'time') &&
        base.samples[m] !== undefined &&
        candidate.samples[m] !== undefined,
    )
    .map(([m, spec]) => ({
      metric: m,
      unit: spec.unit,
      ...compare(base.samples[m]!, candidate.samples[m]!, thresholdOf(def, m), {
        better: spec.better,
      }),
    }))
}
