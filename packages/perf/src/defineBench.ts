/**
 * defineBench.ts — what a benchmark is (docs/plans/perf-harness.md → Code
 * layout) and the registry that holds them.
 *
 * A bench is plain data plus a `run` function: nothing here runs at import
 * time, so the browser layers can pull benches into a lazily loaded chunk
 * (the `/bench` route, `?perf=1` — perf-harness.md → Decisions).
 *
 * Ids are `area.tool.operation` (two or more dot-separated segments after the
 * area: `transform.move.rect`, `deck.open.cold.100`, `command.object.create`);
 * the first segment is the bench's `area`, stated twice so a typo in either
 * fails at definition.
 */

import { drawsFramePerInput, type Fingerprint } from './fingerprint.js'

/** C counters · M micro (Node) · B renderer bench · I interaction · S system. */
export type Layer = 'C' | 'M' | 'B' | 'I' | 'S'

export const LAYERS: readonly Layer[] = ['C', 'M', 'B', 'I', 'S']

export type MetricUnit = 'ms' | 'ns' | 'count' | 'fps' | 'bytes' | 'Mpx' | 'ratio'

export interface MetricSpec {
  unit: MetricUnit
  /** Which way is better; a counter or a time is `lower`, fps is `higher`. */
  better: 'lower' | 'higher'
  /**
   * `work`: a deterministic count of work done (rasters, uploads, renders) —
   * the same on every machine, budgeted exactly in perf/budgets (layer C).
   * `time`: a timing or a rate, compared only on the same machine.
   * Frame counts during a timed gesture are `time`, never `work`.
   */
  kind: 'work' | 'time'
  /**
   * A `work` count of something the page does once a frame, not once an
   * input — the slide-object observer's rAF-batched flush
   * (`y.slideObjects.flush`) and the scene updates it applies (`sg.update`).
   * It equals the inputs' count only where the runtime draws a frame for
   * every input (`drawsFramePerInput`: headless Chromium); anywhere else two
   * inputs can share a frame, so there it is measured as a `time` metric
   * (`metricsFor`). Only on `kind: 'work'`.
   */
  perFrame?: true
  /** Overrides the bench's threshold for this metric (a fraction, 0.05 = 5 %). */
  threshold?: number
}

/** A seeded scene from perf/scenes (generators land with layer B/I). */
export interface SceneRef {
  generator: string
  seed: number
  /** The scene matrix: object counts and the like (`{ texts: 120, images: 40 }`). */
  size?: Readonly<Record<string, number>>
}

/** One run's values, by metric name. */
export type RunValues = Readonly<Record<string, number>>

export interface BenchDef<Ctx = unknown> {
  id: string
  area: string
  layer: Layer
  /** USER_ACTIONS ids (apps/web/src/actions/catalog.ts) this bench covers. */
  actions?: readonly string[]
  /** Command ids (packages/commands registry) this bench covers. */
  commands?: readonly string[]
  scene?: SceneRef
  /** One measured run; returns a value per declared metric. */
  run: (ctx: Ctx) => RunValues | Promise<RunValues>
  metrics: Readonly<Record<string, MetricSpec>>
  /** Smallest relative change reported as a difference (default 5 %). */
  threshold?: number
  /**
   * Warm-up and recorded runs when the command line names none (`--runs`,
   * `--warmup`): a bench whose one run is a long session (the growth benches,
   * a minute or more each) takes fewer than the driver's default 2 + 10.
   */
  runs?: { warmup: number; runs: number }
}

export const DEFAULT_THRESHOLD = 0.05

const SEGMENT = /^[a-z0-9][a-zA-Z0-9-]*$/
const METRIC = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/

/** Why a definition is malformed, or an empty list. */
export function benchProblems(def: BenchDef<never>): string[] {
  const problems: string[] = []
  const segments = def.id.split('.')
  if (segments.length < 3 || !segments.every((s) => SEGMENT.test(s)))
    problems.push(`id '${def.id}' is not area.tool.operation (lowercase segments, 3 or more)`)
  if (segments[0] !== def.area)
    problems.push(`id '${def.id}' does not start with its area '${def.area}'`)
  if (!LAYERS.includes(def.layer))
    problems.push(`layer '${String(def.layer)}' is not one of C/M/B/I/S`)
  const metrics = Object.entries(def.metrics)
  if (metrics.length === 0) problems.push('declares no metrics')
  for (const [name, spec] of metrics) {
    if (!METRIC.test(name)) problems.push(`metric '${name}' is not a dotted camelCase name`)
    if (spec.threshold !== undefined && !validThreshold(spec.threshold))
      problems.push(`metric '${name}': threshold ${spec.threshold} is not in (0, 1)`)
    if (spec.perFrame === true && spec.kind !== 'work')
      problems.push(`metric '${name}': perFrame on a time metric (it qualifies a work count)`)
  }
  if (def.layer === 'C' && !metrics.some(([, s]) => s.kind === 'work'))
    problems.push('a layer C bench needs at least one work metric (its counter budget)')
  if (def.threshold !== undefined && !validThreshold(def.threshold))
    problems.push(`threshold ${def.threshold} is not in (0, 1)`)
  if (
    def.runs !== undefined &&
    !(
      Number.isInteger(def.runs.warmup) &&
      def.runs.warmup >= 0 &&
      Number.isInteger(def.runs.runs) &&
      def.runs.runs >= 1
    )
  )
    problems.push(`runs ${JSON.stringify(def.runs)}: warm-ups ≥ 0 and runs ≥ 1, whole numbers`)
  for (const list of [def.actions, def.commands]) {
    if (list !== undefined && new Set(list).size !== list.length)
      problems.push('names an action or command twice')
  }
  return problems
}

function validThreshold(t: number): boolean {
  return Number.isFinite(t) && t > 0 && t < 1
}

/** Validates and returns the definition (typed), throwing on a malformed one. */
export function defineBench<Ctx>(def: BenchDef<Ctx>): BenchDef<Ctx> {
  const problems = benchProblems(def as BenchDef<never>)
  if (problems.length > 0) throw new Error(`defineBench ${def.id}: ${problems.join('; ')}`)
  return def
}

/**
 * A bench's metrics as a run under `fp` measures them: a `perFrame` work
 * count becomes a time metric where the runtime does not draw a frame per
 * input. Every other metric, and every metric in headless Chromium, is as
 * declared. Results, comparisons and budget checks all go through this, so
 * one runtime's exact count is never another's flaky one.
 */
export function metricsFor(
  metrics: Readonly<Record<string, MetricSpec>>,
  fp: Pick<Fingerprint, 'browser'>,
): Readonly<Record<string, MetricSpec>> {
  if (drawsFramePerInput(fp)) return metrics
  return Object.fromEntries(
    Object.entries(metrics).map(([m, spec]) => {
      if (spec.perFrame !== true) return [m, spec]
      const timed: MetricSpec = {
        unit: spec.unit,
        better: spec.better,
        kind: 'time',
        ...(spec.threshold !== undefined ? { threshold: spec.threshold } : {}),
      }
      return [m, timed]
    }),
  )
}

/** The work metrics a run under `fp` counts exactly (its counter snapshot's keys), sorted. */
export function workMetricsFor(
  metrics: Readonly<Record<string, MetricSpec>>,
  fp: Pick<Fingerprint, 'browser'>,
): string[] {
  return Object.entries(metricsFor(metrics, fp))
    .filter(([, s]) => s.kind === 'work')
    .map(([m]) => m)
    .sort()
}

/** Whether a run under `fp` counts every work metric the bench declares (what a budget is taken from). */
export function countsAllWork(
  metrics: Readonly<Record<string, MetricSpec>>,
  fp: Pick<Fingerprint, 'browser'>,
): boolean {
  return drawsFramePerInput(fp) || !Object.values(metrics).some((s) => s.perFrame === true)
}

/** The threshold a metric of a bench is judged by. */
export function thresholdOf(
  def: Pick<BenchDef<never>, 'threshold' | 'metrics'>,
  metric: string,
): number {
  return def.metrics[metric]?.threshold ?? def.threshold ?? DEFAULT_THRESHOLD
}

export interface BenchRegistry {
  register<Ctx>(def: BenchDef<Ctx>): void
  get(id: string): BenchDef<never> | undefined
  has(id: string): boolean
  list(filter?: { layer?: readonly Layer[]; ids?: readonly string[] }): Array<BenchDef<never>>
}

/** A registry of benches; ids are unique. */
export function createBenchRegistry(defs: ReadonlyArray<BenchDef<never>> = []): BenchRegistry {
  const byId = new Map<string, BenchDef<never>>()
  const registry: BenchRegistry = {
    register(def) {
      const d = defineBench(def) as BenchDef<never>
      if (byId.has(d.id)) throw new Error(`bench '${d.id}' is registered twice`)
      byId.set(d.id, d)
    },
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    list(filter) {
      return [...byId.values()]
        .filter((d) => filter?.layer === undefined || filter.layer.includes(d.layer))
        .filter((d) => filter?.ids === undefined || filter.ids.includes(d.id))
        .sort((a, b) => a.id.localeCompare(b.id))
    },
  }
  for (const d of defs) registry.register(d)
  return registry
}
