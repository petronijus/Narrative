import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  budgetProblems,
  diffCounters,
  formatCounterDiff,
  parseBudget,
  serializeBudget,
} from './budgets.js'
import { benchRegistry, budgetStatus } from './cli/checks.js'
import { readBudget, readBudgets, writeBudget } from './node/budgetFiles.js'

describe('counter diffs', () => {
  it('are exact and readable', () => {
    const diff = diffCounters(
      { 'text.rasters': 0, 'gl.uploads': 12, 'react.commits': 3 },
      { 'text.rasters': 120, 'gl.uploads': 12, 'gl.mipmaps': 4 },
    )
    expect(diff.ok).toBe(false)
    expect(formatCounterDiff(diff)).toEqual([
      'gl.mipmaps: new, 4',
      'react.commits: 3 → removed',
      'text.rasters: 0 → 120 (+120)',
    ])
    expect(formatCounterDiff(diffCounters({ a: 5 }, { a: 2 }))).toEqual(['a: 5 → 2 (-3)'])
    expect(diffCounters({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({ ok: true, changes: [] })
  })
})

describe('budget files', () => {
  it('round-trip, sorted, with a trailing newline', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'narrative-budgets-'))
    try {
      const file = writeBudget('fill.solid.mount', { 'z.last': 1, 'a.first': 2 }, dir)
      const text = readFileSync(file, 'utf8')
      expect(text).toBe(serializeBudget('fill.solid.mount', { 'a.first': 2, 'z.last': 1 }))
      expect(text.indexOf('a.first')).toBeLessThan(text.indexOf('z.last'))
      expect(text.endsWith('}\n')).toBe(true)
      expect(readBudget('fill.solid.mount', dir)?.counters).toEqual({ 'a.first': 2, 'z.last': 1 })
      expect(readBudget('missing.bench.id', dir)).toBeUndefined()
      writeFileSync(path.join(dir, 'broken.one.id.json'), '{"format":1,"id":"other","counters":{}}')
      expect(() => readBudgets(dir)).toThrow(/broken.one.id: id other does not match/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuse what is not a count', () => {
    const text = (counters: unknown) => JSON.stringify({ format: 1, id: 'a.b.c', counters })
    expect(() => parseBudget(text({ x: 1.5 }), 'a.b.c')).toThrow(/not a count/)
    expect(() => parseBudget(text({ x: -1 }), 'a.b.c')).toThrow(/not a count/)
    expect(() => parseBudget(text([]), 'a.b.c')).toThrow(/no counters/)
    expect(() => parseBudget('{', 'a.b.c')).toThrow(/not JSON/)
  })
})

describe('benches against budgets', () => {
  const work = { kind: 'work' } as const
  const time = { kind: 'time' } as const
  it('finds orphaned budgets, unbudgeted work and undeclared counters', () => {
    const problems = budgetProblems(
      [
        { id: 'fill.solid.mount', metrics: { rasters: work, ms: time } },
        { id: 'text.type.inter', metrics: { rasters: work } },
        { id: 'viewport.zoom.wheel', metrics: { ms: time } },
      ],
      [
        { format: 1, id: 'fill.solid.mount', counters: { rasters: 3, ms: 2 } },
        { format: 1, id: 'gone.bench.id', counters: {} },
      ],
    )
    expect(problems).toEqual([
      expect.stringMatching(/fill.solid.mount.json: counts ms/),
      expect.stringMatching(/gone.bench.id.json: no bench/),
      expect.stringMatching(/text.type.inter: work metrics but no budget/),
    ])
  })

  it('the committed budgets match the registered benches', () => {
    expect(budgetStatus(benchRegistry()).problems).toEqual([])
  })
})
