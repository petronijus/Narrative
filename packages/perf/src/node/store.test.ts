import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineBench } from '../defineBench.js'
import type { Fingerprint } from '../fingerprint.js'
import { runBench, type BenchResult } from '../result.js'
import { deployedSource } from './fingerprint.js'
import { baselineKey, openResultStore, perfHome } from './store.js'

const FP: Fingerprint = {
  machine: 'test-box',
  git: { sha: 'a'.repeat(40), dirty: false },
  build: { mode: 'prod', source: { kind: 'local' } },
  os: { platform: 'linux', release: '7.0', arch: 'x64' },
  cpu: { model: 'i9-12900K', cores: 24 },
  loadAvg: [0.5, 0.5, 0.5],
  node: 'v24.15.0',
  power: null,
  takenAt: '2026-10-18T10:00:00.000Z',
}

const bench = defineBench({
  id: 'fill.solid.mount',
  area: 'fill',
  layer: 'B',
  run: () => ({ ms: 12, rasters: 4 }),
  metrics: {
    ms: { unit: 'ms', better: 'lower', kind: 'time' },
    rasters: { unit: 'count', better: 'lower', kind: 'work' },
  },
})

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'narrative-perf-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function result(fp: Fingerprint = FP): Promise<BenchResult> {
  return runBench(bench, undefined, fp, { warmup: 1, runs: 3 })
}

describe('the result store', () => {
  it('lives under the cache home, per machine', () => {
    expect(perfHome({ NARRATIVE_PERF_HOME: '/x/y' })).toBe('/x/y')
    expect(perfHome({ XDG_CACHE_HOME: '/c' })).toBe(path.join('/c', 'narrative-perf'))
    expect(perfHome({})).toBe(path.join(os.homedir(), '.cache', 'narrative-perf'))
    expect(openResultStore({ machine: 'test-box', home }).dir).toBe(path.join(home, 'test-box'))
  })

  it('round-trips results, append-only, oldest first', async () => {
    const store = openResultStore({ machine: 'test-box', home })
    expect(store.results()).toEqual([])
    const a = await result()
    const b = await result()
    store.append(a)
    store.append(b)
    expect(store.results()).toEqual([a, b])
    expect(store.latest('fill.solid.mount')).toEqual(b)
    expect(store.latest('nothing.here.yet')).toBeUndefined()
    expect(a.counters).toEqual({ rasters: 4 })
    const lines = readFileSync(path.join(store.dir, 'results.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it("refuses another machine's result", async () => {
    const store = openResultStore({ machine: 'test-box', home })
    await expect(result({ ...FP, machine: 'other' }).then((r) => store.append(r))).rejects.toThrow(
      /machine other/,
    )
  })

  it('reports a corrupt line instead of skipping it', async () => {
    const store = openResultStore({ machine: 'test-box', home })
    store.append(await result())
    appendFileSync(path.join(store.dir, 'results.jsonl'), '{not json\n')
    expect(() => store.results()).toThrow(/results\.jsonl:2: not JSON/)
  })

  it('accepts baselines per bench, build mode and runtime, keeping the replaced one', async () => {
    const store = openResultStore({ machine: 'test-box', home })
    const prod1 = await result()
    const prod2 = await result()
    const dev = await result({ ...FP, build: { mode: 'dev', source: { kind: 'local' } } })
    expect(store.accept(prod1, new Date('2026-10-18T10:00:00Z'))).toBeUndefined()
    expect(store.accept(dev)).toBeUndefined()
    expect(store.accept(prod2, new Date('2026-10-18T11:00:00Z'))?.result).toEqual(prod1)
    const b = store.baselines()
    expect(Object.keys(b.benches).sort()).toEqual([
      'fill.solid.mount@dev/node',
      'fill.solid.mount@prod/node',
    ])
    expect(store.baselineFor(prod1)?.result).toEqual(prod2)
    expect(store.baselineFor(dev)?.result).toEqual(dev)
    const history = readFileSync(path.join(store.dir, 'baselines.history.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { key: string; result: BenchResult })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ key: 'fill.solid.mount@prod/node', result: prod1 })
  })

  it('a browser result keeps its own series', () => {
    const fp = {
      ...FP,
      browser: { name: 'webkit', version: '26', engine: 'webkit', shell: 'tauri' } as const,
    }
    expect(baselineKey('fill.solid.mount', fp)).toBe('fill.solid.mount@prod/webkit-tauri')
  })

  it('a headed browser keeps a series apart from the headless one', () => {
    const browser = { name: 'webkit', version: '26', engine: 'webkit', shell: 'browser' } as const
    expect(baselineKey('present.advance.text', { ...FP, browser })).toBe(
      'present.advance.text@prod/webkit-browser',
    )
    expect(
      baselineKey('present.advance.text', { ...FP, browser: { ...browser, headed: true } }),
    ).toBe('present.advance.text@prod/webkit-browser-headed')
  })

  it('refuses a baselines file of another machine', () => {
    const store = openResultStore({ machine: 'test-box', home })
    store.append({ ...structuredClone(FP_RESULT), fingerprint: FP })
    writeFileSync(
      path.join(store.dir, 'baselines.json'),
      JSON.stringify({ format: 1, machine: 'other', benches: {} }),
    )
    expect(() => store.baselines()).toThrow(/machine other/)
  })
})

const FP_RESULT: BenchResult = {
  format: 1,
  benchId: 'fill.solid.mount',
  layer: 'B',
  at: '2026-10-18T10:00:00.000Z',
  fingerprint: FP,
  warmup: 0,
  runs: 1,
  samples: { ms: [1] },
  summary: {},
}

describe('the build source of a deployed origin', () => {
  it('reads /version.json', async () => {
    const fake = (async (url: URL) => {
      expect(url.href).toBe('https://narrative.example.com/version.json')
      return new Response(JSON.stringify({ version: '0.15.0' }))
    }) as unknown as typeof fetch
    expect(await deployedSource('https://narrative.example.com/deck/1', fake)).toEqual({
      kind: 'deployed',
      origin: 'https://narrative.example.com',
      version: '0.15.0',
    })
  })

  it('fails on an error or a missing version', async () => {
    const status = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
    await expect(deployedSource('https://x.example', status)).rejects.toThrow(/HTTP 502/)
    const empty = (async () => new Response('{}')) as unknown as typeof fetch
    await expect(deployedSource('https://x.example', empty)).rejects.toThrow(/no version/)
  })
})
