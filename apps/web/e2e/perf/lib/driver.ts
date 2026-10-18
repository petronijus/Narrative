/**
 * e2e/perf/lib/driver.ts — runs the layer I benches of packages/perf
 * (catalog/interaction.ts) in Playwright: one or more sides (a dev page, a
 * production preview, both sides of an A/B), interleaved runs, results
 * fingerprinted and written to this machine's store, compared with its
 * baseline (or side A with side B), counters checked against the committed
 * budgets. Driven by `just perf` / `just perf-compare` / `just perf-profile`
 * (packages/perf/src/cli/run.ts) through these variables:
 *
 *   PERF_RUN=1          run at all (the specs skip otherwise — `just e2e` stays fast)
 *   PERF_IDS            comma-separated bench ids (default: all of the spec)
 *   PERF_MODE           the build mode the page must report: dev | prod | profiling
 *   PERF_SIDES          JSON [{ name, baseURL, version?, rev? }] (default: one side, PW_BASE_URL)
 *   PERF_RUNS, PERF_WARMUP   recorded / warm-up runs per side (default 10 / 2)
 *   PERF_STORE=0        print only, store nothing
 *   PERF_PROFILE=1      one run with a CPU profile (Chromium), written next to the results
 *   PERF_VERDICT_FILE   where to write the A/B verdicts (JSON) for perf-compare / perf-bisect
 *
 * Scene knobs of the old probes still work — PERF_TEXTS, PERF_IMAGES,
 * PERF_RECTS, PERF_PHOTOS, PERF_SLIDES, PERF_GPU, PERF_NO_MASK — but a run
 * with a scene other than the bench's own is printed, never stored: its
 * numbers do not belong to that bench's series.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, LaunchOptions, Page } from '@playwright/test'
import {
  bindRun,
  comparability,
  compareResults,
  diffCounters,
  fmt,
  formatBudgetCheck,
  formatComparisons,
  formatFingerprint,
  INTERACTION_BENCHES,
  refuseToRun,
  runInterleaved,
  type BenchDef,
  type BenchResult,
  type BuildMode,
  type Fingerprint,
  type RunValues,
} from '@narrative/perf'
import { collectFingerprint, machineName, openResultStore, readBudget } from '@narrative/perf/node'
import { installReactPerfHook } from './reactHook'
import { cdpProfiler, summariseProfile, type CpuProfile } from './profile'
import type { Captured } from './page'

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))

function num(name: string, fallback: number): number {
  const v = process.env[name]
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name}=${v} is not a number`)
  return n
}

export interface SideSpec {
  name: string
  baseURL: string
  version?: string
  rev?: string
}

function sides(): SideSpec[] {
  const raw = process.env['PERF_SIDES']
  if (raw !== undefined && raw !== '') return JSON.parse(raw) as SideSpec[]
  const mode = process.env['PERF_MODE'] ?? 'dev'
  return [{ name: mode, baseURL: process.env['PW_BASE_URL'] || 'http://localhost:5173' }]
}

export const PERF = {
  run: process.env['PERF_RUN'] === '1',
  ids: (process.env['PERF_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  mode: (process.env['PERF_MODE'] ?? 'dev') as BuildMode,
  runs: num('PERF_RUNS', 10),
  warmup: num('PERF_WARMUP', 2),
  store: process.env['PERF_STORE'] !== '0',
  profile: process.env['PERF_PROFILE'] === '1',
  sides: sides(),
  gpu: process.env['PERF_GPU'] === '1',
  noMask: process.env['PERF_NO_MASK'] === '1',
}

/** The bench ids of a spec that this run asked for. */
export function selected(specIds: readonly string[]): string[] {
  if (PERF.ids.length === 0) return [...specIds]
  return specIds.filter((id) => PERF.ids.includes(id))
}

export function benchMeta(id: string): BenchDef<never> {
  const def = INTERACTION_BENCHES.find((b) => b.id === id)
  if (def === undefined)
    throw new Error(`no layer I bench ${id} (packages/perf/src/catalog/interaction.ts)`)
  return def
}

// PERF_GPU=1: draw with the machine's GPU instead of the software rasteriser
// headless Chromium falls back to (perf-heavy-slide.spec.ts's knob).
const GPU_ARGS =
  process.platform === 'darwin'
    ? ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
    : [
        '--use-angle=vulkan',
        '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--disable-vulkan-surface',
      ]
export function launchOptions(): LaunchOptions {
  const executablePath = process.env['PLAYWRIGHT_CHROME_EXECUTABLE']
  return {
    args: GPU_ARGS,
    ...(executablePath !== undefined && executablePath !== '' ? { executablePath } : {}),
  }
}

/** A browser context for a side: its origin, the scenario's viewport, the React hook. */
export async function sideContext(
  browser: Browser,
  side: SideSpec,
  viewport: { width: number; height: number },
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: side.baseURL,
    viewport,
    deviceScaleFactor: 1,
  })
  await context.addInitScript(installReactPerfHook)
  return context
}

export interface SideState {
  side: SideSpec
  page: Page
  /** The last measured run's capture (routes, React components) for the details file. */
  last?: Captured
  /** Extra values for the details file. */
  notes?: Record<string, unknown>
}

async function fingerprintFor(browser: Browser, state: SideState): Promise<Fingerprint> {
  const info = await state.page.evaluate(() => {
    const h = window.__narrative_perf_harness!
    return { mode: h.buildMode(), gl: h.gl() }
  })
  if (info.mode !== PERF.mode)
    throw new Error(`side ${state.side.name} runs a ${info.mode} build, PERF_MODE=${PERF.mode}`)
  const fp = collectFingerprint({
    build: {
      mode: PERF.mode,
      source: {
        kind: 'local',
        ...(state.side.version !== undefined ? { version: state.side.version } : {}),
      },
    },
    cwd: REPO,
  })
  const name = browser.browserType().name()
  fp.browser = {
    name,
    version: browser.version(),
    engine: name === 'webkit' ? 'webkit' : name === 'firefox' ? 'gecko' : 'chromium',
    shell: 'browser',
  }
  if (info.gl !== null) fp.gl = info.gl
  return fp
}

export type ScenarioRun<S extends SideState> = (
  state: S,
  def: BenchDef<never>,
) => Promise<RunValues>

export interface Verdict {
  bench: string
  regressions: string[]
  improvements: string[]
  counterChanges: string[]
}

/** A compact line of the headline numbers of a result. */
function headline(def: BenchDef<never>, r: BenchResult): string {
  const pick = [
    'input.p50',
    'input.p90',
    'frame.p90',
    'longTask.total',
    'settle',
    'open.mounted',
    'open.settled',
    'wall',
  ].filter((m) => r.summary[m] !== undefined)
  const time = pick.map((m) => `${m}=${fmt(r.summary[m]!.median)}`).join(' ')
  const work = Object.entries(r.counters ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return `PERF ${def.id.padEnd(26)} ${r.fingerprint.build.mode.padEnd(9)} ${time} | ${work || 'no work counted'}`
}

function detailsDir(storeDir: string): string {
  const dir = path.join(storeDir, 'details')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeDetails(
  storeDir: string,
  result: BenchResult,
  state: SideState,
  extra: Record<string, unknown> = {},
): string {
  const c = state.last
  const file = path.join(
    detailsDir(storeDir),
    `${result.benchId}@${result.fingerprint.build.mode}-${result.fingerprint.browser?.engine ?? 'node'}-${result.at.replace(/[:.]/g, '-')}.json`,
  )
  writeFileSync(
    file,
    JSON.stringify(
      {
        benchId: result.benchId,
        side: state.side,
        at: result.at,
        counters: c?.counters,
        routes: c?.routes,
        react:
          c?.react === null || c?.react === undefined
            ? null
            : { ...c.react, byName: c.react.byName.slice(0, 40) },
        renders: c?.recording.renders,
        inputs:
          c === undefined
            ? undefined
            : {
                n: c.recording.inputs.length,
                canvas: c.recording.inputs.filter((i) => i.via === 'canvas').length,
                dom: c.recording.inputs.filter((i) => i.via === 'dom').length,
              },
        longTasks: c?.recording.longTasks,
        slowEvents: c?.recording.slowEvents?.slice(0, 20),
        restagesDone: c?.recording.restagesDone,
        notes: state.notes,
        ...extra,
      },
      null,
      2,
    ),
  )
  return file
}

/**
 * Run `ids` on every side, interleaved; store, compare and report. `sceneIsDefault`
 * false (a knob changed the scene): print only.
 */
export async function runScenarios<S extends SideState>(o: {
  browser: Browser
  ids: readonly string[]
  states: readonly S[]
  runs: Readonly<Record<string, ScenarioRun<S>>>
  sceneIsDefault: boolean
}): Promise<Verdict[]> {
  const store = openResultStore({ machine: machineName() })
  const fps = new Map<S, Fingerprint>()
  for (const s of o.states) {
    const fp = await fingerprintFor(o.browser, s)
    const refused = refuseToRun(fp)
    if (refused.length > 0) throw new Error(`refusing to run: ${refused.join('; ')}`)
    fps.set(s, fp)
    for (const line of formatFingerprint(fp))
      console.log(`${line}${o.states.length > 1 ? ` [${s.side.name}]` : ''}`)
  }
  const keep = PERF.store && o.sceneIsDefault
  if (!o.sceneIsDefault) console.log('PERF scene knobs changed: results are printed, not stored')
  const verdicts: Verdict[] = []

  const failures: string[] = []
  for (const id of o.ids) {
    try {
      verdicts.push(...(await runOne(id)))
    } catch (err) {
      // One bench failing (a varying work count, a gesture that did not land)
      // must not cost the others their runs; the test fails at the end.
      const message = err instanceof Error ? err.message : String(err)
      console.log(`PERF FAILED ${id}: ${message.split('\n')[0]}`)
      failures.push(`${id}: ${message}`)
    }
  }
  const verdictFile = process.env['PERF_VERDICT_FILE']
  if (verdictFile !== undefined && verdictFile !== '') {
    const before = existsSync(verdictFile)
      ? (JSON.parse(readFileSync(verdictFile, 'utf8')) as Verdict[])
      : []
    writeFileSync(verdictFile, JSON.stringify([...before, ...verdicts], null, 2))
  }
  if (failures.length > 0)
    throw new Error(`${failures.length} bench(es) failed:\n${failures.join('\n')}`)
  return verdicts

  async function runOne(id: string): Promise<Verdict[]> {
    const verdicts: Verdict[] = []
    const meta = benchMeta(id)
    const fn = o.runs[id]
    if (fn === undefined) throw new Error(`the spec has no run for ${id}`)
    let profiles: Array<{ state: S; profile: CpuProfile }> = []
    let n = 0
    const def = bindRun<S>(meta, async (state) => {
      const t = Date.now()
      n++
      if (!PERF.profile) {
        const v = await fn(state, meta)
        if (process.env['PERF_VERBOSE'] === '1')
          console.log(`PERF … ${id} run ${n} [${state.side.name}] ${Date.now() - t} ms`)
        return v
      }
      const profiler = await cdpProfiler(state.page)
      await state.page.evaluate(() => window.__narrative_perf_harness!.setInputFence(false))
      await profiler.start()
      try {
        return await fn(state, meta)
      } finally {
        profiles.push({ state, profile: await profiler.stop() })
      }
    })
    // PERF_DISCOVER=1: every counter as a time metric, and which ones varied —
    // how a bench's `work` list (catalog/interaction.ts) is chosen.
    const discover = process.env['PERF_DISCOVER'] === '1'
    const runDef = discover
      ? {
          ...def,
          metrics: Object.fromEntries(
            Object.entries(def.metrics).map(([k, m]) => [k, { ...m, kind: 'time' as const }]),
          ),
        }
      : def
    const results = await runInterleaved(
      runDef,
      o.states.map((s) => ({ name: s.side.name, ctx: s, fingerprint: fps.get(s)! })),
      PERF.profile ? { warmup: 1, runs: 1 } : { warmup: PERF.warmup, runs: PERF.runs },
    )
    if (discover)
      for (const r of results) {
        const counters = Object.keys(meta.metrics).filter(
          (m) => meta.metrics[m]!.unit === 'count' && !['render.count', 'frame.over50'].includes(m),
        )
        const stable = counters.filter((m) => new Set(r.samples[m]).size === 1)
        const varied = counters.filter((m) => new Set(r.samples[m]).size > 1)
        console.log(
          `PERF discover ${id} stable: ${stable.map((m) => `${m}=${r.samples[m]![0]}`).join(' ')}`,
        )
        console.log(
          `PERF discover ${id} varied: ${varied.map((m) => `${m}=${r.samples[m]!.join('/')}`).join(' ')}`,
        )
      }
    for (const [k, result] of results.entries()) {
      const state = o.states[k]!
      console.log(headline(meta, result))
      if (keep && !PERF.profile && !discover) store.append(result)
      const extra: Record<string, unknown> = {}
      const prof = profiles.filter((p) => p.state === state).at(-1)
      if (prof !== undefined) {
        const file = path.join(
          detailsDir(store.dir),
          `${id}@${result.fingerprint.build.mode}-${result.at.replace(/[:.]/g, '-')}.cpuprofile`,
        )
        writeFileSync(file, JSON.stringify(prof.profile))
        const summary = summariseProfile(prof.profile, 25)
        extra['profile'] = { file, ...summary }
        console.log(`PERF profile ${id} → ${file}`)
        console.log(
          `PERF profile ${id} by category: ${Object.entries(summary.byCategory)
            .filter(([c]) => c !== 'idle')
            .sort((a, b) => b[1] - a[1])
            .map(([c, ms]) => `${c}=${ms.toFixed(0)}ms`)
            .join(' ')}`,
        )
        for (const t of summary.top.slice(0, 15))
          console.log(
            `PERF profile ${id}   ${t.ms.toFixed(1).padStart(7)}ms  ${t.cat.padEnd(7)} ${t.fn}`,
          )
      }
      writeDetails(store.dir, result, state, extra)
      if (o.states.length === 1 && o.sceneIsDefault) {
        const base = store.baselineFor(result)
        if (base === undefined)
          console.log(`PERF ${id}: no baseline on ${store.machine} yet (just perf-accept ${id})`)
        else {
          const ok = comparability(base.result.fingerprint, result.fingerprint)
          if (!ok.ok) console.log(`PERF ${id}: baseline not comparable: ${ok.reasons.join('; ')}`)
          else
            for (const line of formatComparisons(id, compareResults(meta, base.result, result)))
              console.log(line)
        }
        const budget = readBudget(id)
        if (
          result.counters !== undefined &&
          budget !== undefined &&
          result.fingerprint.build.mode === 'dev'
        )
          for (const line of formatBudgetCheck(id, diffCounters(budget.counters, result.counters)))
            console.log(line)
      }
    }
    if (results.length === 2) {
      const [a, b] = results as [BenchResult, BenchResult]
      const ok = comparability(a.fingerprint, b.fingerprint, { ab: true })
      if (!ok.ok) throw new Error(`the two sides are not comparable: ${ok.reasons.join('; ')}`)
      const comparisons = compareResults(meta, a, b)
      console.log(`PERF A/B ${id}: ${o.states[0]!.side.name} → ${o.states[1]!.side.name}`)
      for (const line of formatComparisons(id, comparisons)) console.log(line)
      const counterDiff = diffCounters(a.counters ?? {}, b.counters ?? {})
      for (const line of formatBudgetCheck(id, counterDiff))
        console.log(line.replace('PERF budget', 'PERF A/B counters'))
      verdicts.push({
        bench: id,
        regressions: comparisons.filter((c) => c.verdict === 'regression').map((c) => c.metric),
        improvements: comparisons.filter((c) => c.verdict === 'improvement').map((c) => c.metric),
        counterChanges: counterDiff.changes.map((c) => c.key),
      })
    }
    profiles = []
    return verdicts
  }
}
