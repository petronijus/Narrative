import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ALL_BENCHES } from './benches.js'
import { createBenchRegistry, defineBench, thresholdOf, type BenchDef } from './defineBench.js'
import type { Fingerprint } from './fingerprint.js'
import { compareResults, runBench, runInterleaved } from './result.js'
import { formatBudgetCheck, formatComparisons, formatResult, table } from './report.js'
import { diffCounters } from './budgets.js'

const ms = { unit: 'ms', better: 'lower', kind: 'time' } as const
const rasters = { unit: 'count', better: 'lower', kind: 'work' } as const

function def(over: Partial<BenchDef> = {}): BenchDef {
  return {
    id: 'transform.move.rect',
    area: 'transform',
    layer: 'I',
    run: () => ({ ms: 1 }),
    metrics: { ms },
    ...over,
  }
}

const FP: Fingerprint = {
  machine: 'm',
  git: null,
  build: { mode: 'prod', source: { kind: 'local' } },
  os: { platform: 'linux', release: '7', arch: 'x64' },
  cpu: { model: 'cpu', cores: 8 },
  loadAvg: [0, 0, 0],
  node: 'v24',
  power: null,
  takenAt: '2026-10-18T00:00:00.000Z',
}

describe('defineBench', () => {
  it('takes default run counts only as whole numbers, at least one recorded run', () => {
    expect(() => defineBench(def({ runs: { warmup: 1, runs: 3 } }))).not.toThrow()
    expect(() => defineBench(def({ runs: { warmup: 0, runs: 1 } }))).not.toThrow()
    expect(() => defineBench(def({ runs: { warmup: 1, runs: 0 } }))).toThrow(/runs/)
    expect(() => defineBench(def({ runs: { warmup: -1, runs: 2 } }))).toThrow(/runs/)
    expect(() => defineBench(def({ runs: { warmup: 1.5, runs: 2 } }))).toThrow(/runs/)
  })

  it('accepts area.tool.operation ids starting with their area', () => {
    for (const id of [
      'transform.move.rect',
      'deck.open.cold.100',
      'command.object.create',
      'font.custom.first-use',
    ])
      expect(() => defineBench(def({ id, area: id.split('.')[0]! }))).not.toThrow()
  })

  it('refuses malformed definitions, naming every problem', () => {
    expect(() => defineBench(def({ id: 'transform.move' }))).toThrow(/area.tool.operation/)
    expect(() => defineBench(def({ id: 'Transform.Move.Rect', area: 'Transform' }))).toThrow(
      /lowercase/,
    )
    expect(() => defineBench(def({ area: 'fill' }))).toThrow(/does not start with its area/)
    expect(() => defineBench(def({ metrics: {} }))).toThrow(/no metrics/)
    expect(() => defineBench(def({ threshold: 5 }))).toThrow(/threshold 5/)
    expect(() => defineBench(def({ layer: 'C' }))).toThrow(
      /layer C bench needs at least one work metric/,
    )
    expect(() => defineBench(def({ actions: ['a', 'a'] }))).toThrow(/twice/)
  })

  it('thresholds: the metric’s, else the bench’s, else 5 %', () => {
    const d = def({ threshold: 0.1, metrics: { ms, rasters: { ...rasters, threshold: 0.02 } } })
    expect(thresholdOf(d, 'rasters')).toBe(0.02)
    expect(thresholdOf(d, 'ms')).toBe(0.1)
    expect(thresholdOf(def(), 'ms')).toBe(0.05)
  })

  it('the registry refuses duplicates and lists in id order', () => {
    const r = createBenchRegistry([
      def({ id: 'transform.rotate.rect' }),
      def(),
      def({ id: 'transform.flip.h', layer: 'B' }),
    ])
    expect(() => r.register(def())).toThrow(/registered twice/)
    expect(r.list().map((d) => d.id)).toEqual([
      'transform.flip.h',
      'transform.move.rect',
      'transform.rotate.rect',
    ])
    expect(r.list({ layer: ['B'] }).map((d) => d.id)).toEqual(['transform.flip.h'])
  })

  it('every bench of the harness is well formed', () => {
    expect(() => createBenchRegistry(ALL_BENCHES)).not.toThrow()
  })
})

describe('runBench', () => {
  it('summarises the runs and snapshots the work metrics', async () => {
    let i = 0
    const r = await runBench(
      def({ run: () => ({ ms: ++i, rasters: 7 }), metrics: { ms, rasters } }),
      undefined,
      FP,
      { warmup: 1, runs: 5 },
    )
    expect(r.samples).toEqual({ ms: [2, 3, 4, 5, 6], rasters: [7, 7, 7, 7, 7] })
    expect(r.summary['ms']?.median).toBe(4)
    expect(r.counters).toEqual({ rasters: 7 })
  })

  it('refuses a work count that varies between runs', async () => {
    let i = 0
    await expect(
      runBench(
        def({ run: () => ({ ms: 1, rasters: ++i }), metrics: { ms, rasters } }),
        undefined,
        FP,
        { warmup: 0, runs: 3 },
      ),
    ).rejects.toThrow(/work metrics varied/)
  })

  it('compares the time metrics of two results', async () => {
    const d = def()
    const slow = await runBench({ ...d, run: () => ({ ms: 20 }) }, undefined, FP, {
      warmup: 0,
      runs: 5,
    })
    const fast = await runBench({ ...d, run: () => ({ ms: 10 }) }, undefined, FP, {
      warmup: 0,
      runs: 5,
    })
    const [c] = compareResults(d, fast, slow)
    expect(c).toMatchObject({ metric: 'ms', verdict: 'regression', relative: 1 })
    const lines = formatComparisons(d.id, compareResults(d, fast, slow))
    expect(lines[0]).toMatch(
      /^PERF transform.move.rect {2}ms {2}10 → 20ms {2}\+100.0% {2}CI \[10, 10\] {2}REGRESSION$/,
    )
    expect(formatResult(d, slow)[0]).toMatch(
      /^PERF transform.move.rect {2}ms {2}median=20ms {2}p90=20 {2}mad=0 {2}n=5$/,
    )
  })
})

describe('runInterleaved', () => {
  it('alternates the sides run by run, warm-ups included, and returns one result each', async () => {
    const order: string[] = []
    const d = def({
      run: (side) => {
        order.push(String(side))
        return { ms: side === 'a' ? 10 : 20, rasters: 3 }
      },
      metrics: { ms, rasters },
    })
    const [a, b] = await runInterleaved(
      d,
      [
        { name: 'A', ctx: 'a', fingerprint: FP },
        { name: 'B', ctx: 'b', fingerprint: FP },
      ],
      { warmup: 1, runs: 2 },
    )
    expect(order).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
    expect(a?.samples['ms']).toEqual([10, 10])
    expect(b?.samples['ms']).toEqual([20, 20])
    expect(b?.counters).toEqual({ rasters: 3 })
  })

  it('refuses a run that leaves out or adds a metric', async () => {
    const side = [{ name: 'A', ctx: undefined, fingerprint: FP }]
    await expect(
      runInterleaved(def({ run: () => ({ rasters: 1 }), metrics: { ms, rasters } }), side, {
        warmup: 0,
        runs: 1,
      }),
    ).rejects.toThrow(/no number for metric 'ms'/)
    await expect(
      runInterleaved(
        def({ run: () => ({ ms: 1, rasters: 1, x: 2 }), metrics: { ms, rasters } }),
        side,
        {
          warmup: 0,
          runs: 1,
        },
      ),
    ).rejects.toThrow(/undeclared \[x\]/)
  })
})

describe('the reporter', () => {
  it('aligns columns', () => {
    expect(
      table([
        ['a', 'bbb', 'c'],
        ['aaa', 'b', 'c'],
      ]),
    ).toEqual(['PERF a    bbb  c', 'PERF aaa  b    c'])
  })

  it('prints a budget diff', () => {
    expect(formatBudgetCheck('fill.solid.mount', diffCounters({ r: 0 }, { r: 120 }))).toEqual([
      'PERF budget fill.solid.mount: r: 0 → 120 (+120)',
    ])
    expect(formatBudgetCheck('x', diffCounters({}, {}))).toEqual(['PERF budget x: ok'])
  })
})

describe('the browser-safe core', () => {
  it('imports nothing of Node outside src/node and src/cli (the /bench chunk carries it)', () => {
    const src = path.dirname(fileURLToPath(import.meta.url))
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const full = path.join(dir, n)
        if (statSync(full).isDirectory()) return n === 'node' || n === 'cli' ? [] : files(full)
        return n.endsWith('.ts') && !n.endsWith('.test.ts') ? [full] : []
      })
    const offenders = files(src).filter((f) =>
      /from '(node:|\.\/node\/|\.\/cli\/|@narrative\/commands)/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders.map((f) => path.relative(src, f))).toEqual([])
  })
})
