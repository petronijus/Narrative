/**
 * result.ts — one bench run as it is stored (results.jsonl), compared and
 * printed, and the function that produces it.
 */

import { thresholdOf, type BenchDef, type Layer } from './defineBench.js'
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
  /** The work metrics of the run, when they did not vary between runs — the counter snapshot. */
  counters?: Record<string, number>
}

/**
 * The stored result of `samples` recorded for `def` under `fingerprint`:
 * summaries, and the counter snapshot of its work metrics — which must not
 * have varied between runs.
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
  const work = names.filter((m) => def.metrics[m]!.kind === 'work')
  const unstable = work.filter((m) => new Set(samples[m]).size > 1)
  if (unstable.length > 0)
    throw new Error(
      `${def.id}: work metrics varied between runs (${unstable
        .map((m) => `${m} ${samples[m]!.join('/')}`)
        .join(', ')}): a work count must be deterministic — ` +
        'declare it as kind "time" or fix what makes it vary',
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
  options: MeasureOptions = {},
): Promise<BenchResult> {
  const warmup = options.warmup ?? 3
  const runs = options.runs ?? 15
  const names = Object.keys(def.metrics)
  const samples = await measure(() => def.run(ctx), names, { warmup, runs })
  return resultFrom(def as BenchDef<never>, samples, fingerprint, warmup, runs)
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
  options: MeasureOptions = {},
): Promise<BenchResult[]> {
  const warmup = options.warmup ?? 3
  const runs = options.runs ?? 15
  const names = Object.keys(def.metrics)
  const samples = sides.map(() => Object.fromEntries(names.map((m) => [m, [] as number[]])))
  const once = async (side: Side<Ctx>): Promise<Record<string, number>> => {
    const values = await def.run(side.ctx)
    const extra = Object.keys(values).filter((k) => !names.includes(k))
    if (extra.length > 0)
      throw new Error(`${def.id} on ${side.name}: run returned undeclared [${extra.join(', ')}]`)
    for (const m of names)
      if (typeof values[m] !== 'number' || !Number.isFinite(values[m]))
        throw new Error(`${def.id} on ${side.name}: run returned no number for metric '${m}'`)
    return values as Record<string, number>
  }
  for (let i = 0; i < warmup; i++) for (const side of sides) await once(side)
  for (let i = 0; i < runs; i++)
    for (const [k, side] of sides.entries()) {
      const values = await once(side)
      for (const m of names) samples[k]![m]!.push(values[m]!)
    }
  return sides.map((side, k) =>
    resultFrom(def as BenchDef<never>, samples[k]!, side.fingerprint, warmup, runs),
  )
}

export interface MetricComparison extends Comparison {
  metric: string
  unit: string
}

/** Compare every time metric two results of one bench share (work metrics go to the budgets). */
export function compareResults(
  def: Pick<BenchDef<never>, 'id' | 'metrics' | 'threshold'>,
  base: BenchResult,
  candidate: BenchResult,
): MetricComparison[] {
  if (base.benchId !== def.id || candidate.benchId !== def.id)
    throw new Error(
      `compareResults: results of ${base.benchId} / ${candidate.benchId}, not ${def.id}`,
    )
  return Object.entries(def.metrics)
    .filter(
      ([m, spec]) =>
        spec.kind === 'time' && base.samples[m] !== undefined && candidate.samples[m] !== undefined,
    )
    .map(([m, spec]) => ({
      metric: m,
      unit: spec.unit,
      ...compare(base.samples[m]!, candidate.samples[m]!, thresholdOf(def, m), {
        better: spec.better,
      }),
    }))
}
