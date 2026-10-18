/**
 * budgets.ts — counter budgets (layer C, docs/plans/perf-harness.md → The
 * counters): the exact work counts of a scenario, committed as
 * `perf/budgets/<id>.json`. The comparison is exact — a work count is
 * deterministic — and the diff is the review ("text.rasters: 0 → 120").
 *
 * Pure parsing, comparing and serialising; reading and writing the files is
 * `@narrative/perf/node` (budgetFiles.ts).
 */

export const BUDGET_FORMAT = 1

/**
 * The build mode budgets are measured in: dev, the stack `just ci` runs
 * against. Work counts are GPU-independent but not quite mode-independent
 * (code requests differ, React renders twice in StrictMode — and those are
 * time metrics), so a budget is compared only with dev results.
 */
export const BUDGET_MODE = 'dev'

export interface CounterBudget {
  format: typeof BUDGET_FORMAT
  id: string
  counters: Record<string, number>
}

export interface CounterChange {
  key: string
  /** null: not in the budget (a new counter). */
  from: number | null
  /** null: not counted any more (a removed counter). */
  to: number | null
}

export interface CounterDiff {
  ok: boolean
  changes: CounterChange[]
}

/** Exact comparison of a budget with a measured snapshot; changes in key order. */
export function diffCounters(
  budget: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
): CounterDiff {
  const keys = [...new Set([...Object.keys(budget), ...Object.keys(actual)])].sort()
  const changes: CounterChange[] = []
  for (const key of keys) {
    const from = Object.hasOwn(budget, key) ? budget[key]! : null
    const to = Object.hasOwn(actual, key) ? actual[key]! : null
    if (from !== to) changes.push({ key, from, to })
  }
  return { ok: changes.length === 0, changes }
}

/** One line per change: `text.rasters: 0 → 120 (+120)`, `gl.mipmaps: new, 4`, `react.commits: 3 → removed`. */
export function formatCounterDiff(diff: CounterDiff): string[] {
  return diff.changes.map(({ key, from, to }) => {
    if (from === null) return `${key}: new, ${to}`
    if (to === null) return `${key}: ${from} → removed`
    const delta = to - from
    return `${key}: ${from} → ${to} (${delta > 0 ? '+' : ''}${delta})`
  })
}

/** Parse and validate a budget file's text; `expectedId` is the file's name without `.json`. */
export function parseBudget(text: string, expectedId: string): CounterBudget {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`budget ${expectedId}: not JSON (${(e as Error).message})`, { cause: e })
  }
  const fail = (why: string): never => {
    throw new Error(`budget ${expectedId}: ${why}`)
  }
  if (typeof raw !== 'object' || raw === null) return fail('not an object')
  const o = raw as Record<string, unknown>
  if (o['format'] !== BUDGET_FORMAT)
    fail(`format ${String(o['format'])}, expected ${BUDGET_FORMAT}`)
  if (o['id'] !== expectedId) fail(`id ${String(o['id'])} does not match the file name`)
  const counters = o['counters']
  if (typeof counters !== 'object' || counters === null || Array.isArray(counters))
    return fail('no counters object')
  for (const [k, v] of Object.entries(counters))
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      fail(`counter ${k} = ${String(v)} is not a count`)
  return { format: BUDGET_FORMAT, id: expectedId, counters: counters as Record<string, number> }
}

/** The file's text: keys sorted, two-space JSON (what Prettier leaves alone), trailing newline. */
export function serializeBudget(id: string, counters: Readonly<Record<string, number>>): string {
  const sortedCounters = Object.fromEntries(
    Object.entries(counters).sort(([a], [b]) => a.localeCompare(b)),
  )
  const budget: CounterBudget = { format: BUDGET_FORMAT, id, counters: sortedCounters }
  return JSON.stringify(budget, null, 2) + '\n'
}

/**
 * What is wrong between the benches and the committed budgets: a budget for a
 * bench that does not exist or measures no work, a bench with work metrics
 * but no budget, a budget counting what the bench does not declare.
 */
export function budgetProblems(
  benches: ReadonlyArray<{
    id: string
    metrics: Readonly<Record<string, { kind: 'work' | 'time' }>>
  }>,
  budgets: readonly CounterBudget[],
): string[] {
  const problems: string[] = []
  const byId = new Map(benches.map((b) => [b.id, b]))
  const budgeted = new Set(budgets.map((b) => b.id))
  for (const budget of budgets) {
    const bench = byId.get(budget.id)
    if (bench === undefined) {
      problems.push(`perf/budgets/${budget.id}.json: no bench ${budget.id} (delete the file)`)
      continue
    }
    const work = Object.entries(bench.metrics)
      .filter(([, s]) => s.kind === 'work')
      .map(([m]) => m)
    const undeclared = Object.keys(budget.counters).filter((k) => !work.includes(k))
    if (undeclared.length > 0)
      problems.push(
        `perf/budgets/${budget.id}.json: counts ${undeclared.join(', ')}, which ${budget.id} does not declare as work metrics`,
      )
  }
  for (const bench of benches)
    if (Object.values(bench.metrics).some((s) => s.kind === 'work') && !budgeted.has(bench.id))
      problems.push(
        `${bench.id}: work metrics but no budget (measure it, then: just perf-accept ${bench.id})`,
      )
  return problems
}
