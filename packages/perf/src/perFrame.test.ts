/**
 * perFrame counts (W1): a drag's once-a-frame work is budgeted exactly where
 * the runtime draws a frame per input (headless Chromium) and timed in every
 * display-paced or self-paced runtime, while its per-move counts stay exact
 * everywhere.
 */

import { describe, expect, it } from 'vitest'
import { budgetResult, diffBudget, formatCounterDiff } from './budgets.js'
import { benchRegistry, budgetStatus } from './cli/checks.js'
import {
  benchProblems,
  countsAllWork,
  metricsFor,
  workMetricsFor,
  type BenchDef,
  type MetricSpec,
} from './defineBench.js'
import { drawsFramePerInput, type Fingerprint } from './fingerprint.js'
import { INTERACTION_BENCHES } from './catalog/interaction.js'
import type { ResultStore } from './node/store.js'
import { compareResults, runBench, type BenchResult } from './result.js'

type Browser = NonNullable<Fingerprint['browser']>

const CHROMIUM: Browser = { name: 'chromium', version: '156', engine: 'chromium', shell: 'browser' }
const WEBKIT: Browser = { name: 'webkit', version: '26', engine: 'webkit', shell: 'browser' }
const TAURI: Browser = { name: 'wkwebview', version: '26', engine: 'webkit', shell: 'tauri' }

function fp(browser: Browser | undefined, mode: 'dev' | 'prod' = 'dev'): Fingerprint {
  return {
    machine: 'm',
    git: null,
    build: { mode, source: { kind: 'local' } },
    os: { platform: 'darwin', release: '27', arch: 'arm64' },
    cpu: { model: 'cpu', cores: 8 },
    loadAvg: [0, 0, 0],
    node: 'v24',
    power: null,
    takenAt: '2026-10-23T00:00:00.000Z',
    ...(browser !== undefined ? { browser } : {}),
  }
}

const ms: MetricSpec = { unit: 'ms', better: 'lower', kind: 'time' }
const work: MetricSpec = { unit: 'count', better: 'lower', kind: 'work' }
const perFrame: MetricSpec = { unit: 'count', better: 'lower', kind: 'work', perFrame: true }
const METRICS = { ms, 'y.tx.local': work, 'y.slideObjects.flush': perFrame }

function drag(flushes: () => number): BenchDef {
  return {
    id: 'transform.move.rect',
    area: 'transform',
    layer: 'I',
    run: () => ({ ms: 10, 'y.tx.local': 90, 'y.slideObjects.flush': flushes() }),
    metrics: METRICS,
  }
}

describe('drawsFramePerInput', () => {
  it('only headless Chromium in a browser draws a frame per input', () => {
    expect(drawsFramePerInput(fp(CHROMIUM))).toBe(true)
    expect(drawsFramePerInput(fp({ ...CHROMIUM, headed: true }))).toBe(false)
    expect(drawsFramePerInput(fp({ ...CHROMIUM, shell: 'electron' }))).toBe(false)
    expect(drawsFramePerInput(fp(WEBKIT))).toBe(false)
    expect(drawsFramePerInput(fp({ ...WEBKIT, headed: true }))).toBe(false)
    expect(drawsFramePerInput(fp(TAURI))).toBe(false)
    expect(drawsFramePerInput(fp(undefined))).toBe(false)
  })
})

describe('metricsFor', () => {
  it('keeps a perFrame count as work in headless Chromium', () => {
    expect(metricsFor(METRICS, fp(CHROMIUM))).toBe(METRICS)
    expect(workMetricsFor(METRICS, fp(CHROMIUM))).toEqual(['y.slideObjects.flush', 'y.tx.local'])
  })

  it('times a perFrame count in a paced runtime, and only that one', () => {
    for (const b of [WEBKIT, TAURI, { ...WEBKIT, headed: true as const }]) {
      const m = metricsFor(METRICS, fp(b))
      expect(m['y.slideObjects.flush']).toEqual({ unit: 'count', better: 'lower', kind: 'time' })
      expect(m['y.tx.local']).toBe(work)
      expect(m['ms']).toBe(ms)
      expect(workMetricsFor(METRICS, fp(b))).toEqual(['y.tx.local'])
    }
  })

  it('keeps a per-metric threshold when it times a count', () => {
    const m = metricsFor({ f: { ...perFrame, threshold: 0.2 } }, fp(TAURI))
    expect(m['f']).toEqual({ unit: 'count', better: 'lower', kind: 'time', threshold: 0.2 })
  })

  it('countsAllWork: false only for a bench with perFrame counts in a paced runtime', () => {
    expect(countsAllWork(METRICS, fp(CHROMIUM))).toBe(true)
    expect(countsAllWork(METRICS, fp(TAURI))).toBe(false)
    expect(countsAllWork({ ms, 'y.tx.local': work }, fp(TAURI))).toBe(true)
  })

  it('perFrame qualifies a work count only', () => {
    const d = drag(() => 90)
    expect(benchProblems({ ...d, metrics: { ms: { ...ms, perFrame: true } } })).toEqual([
      "metric 'ms': perFrame on a time metric (it qualifies a work count)",
    ])
    expect(benchProblems(d)).toEqual([])
  })
})

describe('a drag whose flushes vary with the frames', () => {
  const coalescing = () => {
    let i = 0
    return () => [90, 88, 85, 90, 89][i++ % 5]!
  }

  it('is refused in headless Chromium, where every move gets its frame', async () => {
    await expect(
      runBench(drag(coalescing()), undefined, fp(CHROMIUM), { warmup: 0, runs: 5 }),
    ).rejects.toThrow(/y.slideObjects.flush 90\/88\/85\/90\/89.*perFrame/)
  })

  it('is a result in a paced runtime: the per-move count snapshotted, the flushes timed', async () => {
    const r = await runBench(drag(coalescing()), undefined, fp(TAURI), { warmup: 0, runs: 5 })
    expect(r.counters).toEqual({ 'y.tx.local': 90 })
    expect(r.samples['y.slideObjects.flush']).toEqual([90, 88, 85, 90, 89])
    expect(r.summary['y.slideObjects.flush']?.median).toBe(89)
  })

  it('still refuses a per-move count that varies in a paced runtime', async () => {
    let i = 0
    const d: BenchDef = {
      ...drag(() => 90),
      run: () => ({ ms: 1, 'y.tx.local': 89 + (i++ % 2), 'y.slideObjects.flush': 80 }),
    }
    await expect(runBench(d, undefined, fp(TAURI), { warmup: 0, runs: 3 })).rejects.toThrow(
      /work metrics varied between runs \(y.tx.local/,
    )
  })

  it('compares its flushes as a time metric in a paced runtime, not in headless Chromium', async () => {
    const d = drag(() => 90)
    const opts = { warmup: 0, runs: 5 }
    const paced = [
      await runBench(d, undefined, fp(TAURI), opts),
      await runBench(d, undefined, fp(TAURI), opts),
    ] as const
    expect(compareResults(d, ...paced).map((c) => c.metric)).toEqual(['ms', 'y.slideObjects.flush'])
    const headless = [
      await runBench(d, undefined, fp(CHROMIUM), opts),
      await runBench(d, undefined, fp(CHROMIUM), opts),
    ] as const
    expect(compareResults(d, ...headless).map((c) => c.metric)).toEqual(['ms'])
  })
})

describe('budgets of a bench with perFrame counts', () => {
  const budget = { 'y.tx.local': 90, 'y.slideObjects.flush': 90 }
  const result = (b: Browser, counters: Record<string, number>, mode: 'dev' | 'prod' = 'dev') =>
    ({ fingerprint: fp(b, mode), counters }) as Pick<BenchResult, 'fingerprint' | 'counters'>

  it('a paced run is checked on its per-move counts only', () => {
    expect(diffBudget(METRICS, budget, result(TAURI, { 'y.tx.local': 90 }))).toEqual({
      ok: true,
      changes: [],
    })
    const off = diffBudget(METRICS, budget, result(TAURI, { 'y.tx.local': 91 }))
    expect(formatCounterDiff(off)).toEqual(['y.tx.local: 90 → 91 (+1)'])
  })

  it('a headless Chromium run is checked on every count', () => {
    const d = diffBudget(
      METRICS,
      budget,
      result(CHROMIUM, { 'y.tx.local': 90, 'y.slideObjects.flush': 89 }),
    )
    expect(formatCounterDiff(d)).toEqual(['y.slideObjects.flush: 90 → 89 (-1)'])
  })

  it('a budgeted key the bench does not declare is still reported', () => {
    const d = diffBudget(METRICS, { ...budget, gone: 1 }, result(TAURI, { 'y.tx.local': 90 }))
    expect(formatCounterDiff(d)).toEqual(['gone: 1 → removed'])
  })

  it('is taken from the newest dev result that counts every work metric', () => {
    const results = [
      result(CHROMIUM, budget),
      result(CHROMIUM, { ...budget, 'y.tx.local': 92 }),
      result(CHROMIUM, budget, 'prod'),
      result(TAURI, { 'y.tx.local': 90 }),
      result(WEBKIT, { 'y.tx.local': 90 }),
    ]
    expect(budgetResult(METRICS, results)).toBe(results[1])
    expect(budgetResult(METRICS, results.slice(3))).toBeUndefined()
    // A bench without perFrame counts takes the newest dev result of any runtime.
    expect(budgetResult({ 'y.tx.local': work }, results)).toBe(results[4])
  })

  it('perf-counters checks a budget against the newest full-work result, not a newer paced one', () => {
    const id = 'transform.move.rect'
    const registry = benchRegistry()
    const bench = registry.get(id)!
    const budgeted = Object.fromEntries(
      workMetricsFor(bench.metrics, fp(CHROMIUM)).map((m) => [m, m.startsWith('y.') ? 90 : 0]),
    )
    const paced = Object.fromEntries(
      workMetricsFor(bench.metrics, fp(TAURI)).map((m) => [m, budgeted[m]!]),
    )
    const stored = [
      { benchId: id, ...result(CHROMIUM, { ...budgeted, 'y.slideObjects.flush': 89 }) },
      { benchId: id, ...result(TAURI, paced) },
    ] as BenchResult[]
    const store = {
      results: (f?: { benchId?: string }) => stored.filter((r) => r.benchId === f?.benchId),
    } as unknown as ResultStore
    const [status] = budgetStatus(registry, [{ format: 1, id, counters: budgeted }], store).diffs
    expect(status?.diff === null ? null : formatCounterDiff(status!.diff)).toEqual([
      'y.slideObjects.flush: 90 → 89 (-1)',
    ])
    // With only the paced result stored, the budget is not measured here yet.
    const pacedOnly = {
      results: () => [stored[1]!],
    } as unknown as ResultStore
    expect(
      budgetStatus(registry, [{ format: 1, id, counters: budgeted }], pacedOnly).diffs,
    ).toEqual([{ id, diff: null }])
  })
})

describe('the catalogue', () => {
  const byId = new Map(INTERACTION_BENCHES.map((b) => [b.id, b]))
  const perFrameOf = (id: string) =>
    Object.entries(byId.get(id)!.metrics)
      .filter(([, s]) => s.perFrame === true)
      .map(([m]) => m)
      .sort()
  const workOf = (id: string) =>
    Object.entries(byId.get(id)!.metrics)
      .filter(([, s]) => s.kind === 'work')
      .map(([m]) => m)
      .sort()
  const DRAGS = [
    'transform.move.rect',
    'transform.move.text',
    'transform.move.image',
    'transform.move.multi',
    'transform.move.rect.light',
    'transform.move.table',
  ]

  it('every drag times its flush and scene updates where moves can share a frame', () => {
    for (const id of DRAGS)
      expect(perFrameOf(id), id).toEqual(['sg.update', 'y.slideObjects.flush'])
  })

  it('the table drag budgets what every other drag does (E5 timed its per-move counts)', () => {
    for (const id of DRAGS) expect(workOf(id), id).toEqual(workOf('transform.move.rect'))
    expect(workOf('transform.move.table')).toEqual(
      expect.arrayContaining(['y.tx.local', 'y.observeDeep.slideObjects']),
    )
  })

  it('only drags have perFrame counts: a nudge is one key, one frame', () => {
    const others = INTERACTION_BENCHES.filter((b) => !DRAGS.includes(b.id))
    for (const b of others) expect(perFrameOf(b.id), b.id).toEqual([])
    expect(workOf('transform.nudge.rect')).toEqual(workOf('transform.move.rect'))
  })

  it('in a paced runtime a drag still budgets its per-move counts', () => {
    const m = byId.get('transform.move.rect')!.metrics
    expect(workMetricsFor(m, fp(TAURI))).toEqual(
      workOf('transform.move.rect').filter(
        (k) => k !== 'sg.update' && k !== 'y.slideObjects.flush',
      ),
    )
  })
})
