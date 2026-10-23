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
 *   PERF_RUNS, PERF_WARMUP   recorded / warm-up runs per side (default: the bench's `runs`, else 10 / 2)
 *   PERF_STORE=0        print only, store nothing
 *   PERF_HEADED=1       the browser draws in a window (`--headed`); its own baseline series
 *   PERF_SHELL=tauri    the page is the Tauri window (`--shell tauri`, tauriPage.ts); its own series
 *   PERF_DEVICE_SCALE   the page's devicePixelRatio (default: 1 in a browser, the screen's in Tauri)
 *   PERF_ANTIALIAS=off  every WebGL context without MSAA (a diagnostic A/B, W4): printed, never stored
 *   PERF_LOW_POWER=1    run WebKit in macOS Low Power Mode on purpose (its 30 fps cap is the
 *                       subject: performance.md → E, Low Power Mode): printed, never stored
 *   PERF_PROFILE=1      one run with a CPU profile (Chromium), written next to the results
 *   PERF_NETWORK_RETRIES  extra attempts of a run a network change disturbed (default 3;
 *                       packages/perf/README.md → Run validity)
 *   PERF_SIMULATE_NETWORK_CHANGE=n[,m…]  take the side's context offline for 300 ms in the
 *                       n-th attempt of each bench (warm-ups included, counted over the sides)
 *                       and fire a request into it: proves the discard path end to end —
 *                       printed, never stored
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
  clockTime,
  comparability,
  compareResults,
  diffBudget,
  diffCounters,
  drawsFramePerInput,
  fmt,
  formatBudgetCheck,
  formatComparisons,
  formatDiscards,
  formatFingerprint,
  GUARD_RETRIES,
  INTERACTION_BENCHES,
  refuseToRun,
  runInterleaved,
  type BenchDef,
  type BenchResult,
  type BuildMode,
  type Fingerprint,
  type RunGuard,
  type RunValues,
} from '@narrative/perf'
import { collectFingerprint, machineName, openResultStore, readBudget } from '@narrative/perf/node'
import { NetworkMonitor } from '../../fixtures/networkChange'
import { installReactPerfHook } from './reactHook'
import { cdpProfiler, summariseProfile, type CpuProfile } from './profile'
import type { Captured } from './page'
import { isTauriPage, systemWebKitVersion, tauriPage } from './tauriPage'

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

/** PERF_SIMULATE_NETWORK_CHANGE: the attempt numbers to disturb. */
function simulated(): number[] {
  return (process.env['PERF_SIMULATE_NETWORK_CHANGE'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const n = Number(s)
      if (!Number.isInteger(n) || n < 1)
        throw new Error(`PERF_SIMULATE_NETWORK_CHANGE=${s} is not an attempt number (1, 2, …)`)
      return n
    })
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
  /** Whether the command line set them: otherwise a bench's own `runs` (BenchDef.runs) wins. */
  runsGiven: (process.env['PERF_RUNS'] ?? '') !== '',
  warmupGiven: (process.env['PERF_WARMUP'] ?? '') !== '',
  store:
    process.env['PERF_STORE'] !== '0' &&
    process.env['PERF_ANTIALIAS'] !== 'off' &&
    process.env['PERF_LOW_POWER'] !== '1' &&
    simulated().length === 0,
  /** Extra attempts of a run that a network change disturbed, before the bench fails. */
  networkRetries: num('PERF_NETWORK_RETRIES', GUARD_RETRIES),
  /** Attempts (1-based, per bench, warm-ups included) to disturb on purpose. */
  simulate: simulated(),
  /** WebKit in Low Power Mode measured on purpose (refuseToRun lets it through). */
  lowPower: process.env['PERF_LOW_POWER'] === '1',
  profile: process.env['PERF_PROFILE'] === '1',
  sides: sides(),
  gpu: process.env['PERF_GPU'] === '1',
  /** A window on the screen (`just perf --headed`), recorded in the fingerprint. */
  headed: process.env['PERF_HEADED'] === '1',
  /** Where the page runs: a Playwright browser, or the Tauri window (`--shell tauri`). */
  shell: (process.env['PERF_SHELL'] === 'tauri' ? 'tauri' : 'browser') as 'browser' | 'tauri',
  /** The page's devicePixelRatio; null = the shell's own (1 in a Playwright context, the screen's in Tauri). */
  deviceScale: process.env['PERF_DEVICE_SCALE'] ? num('PERF_DEVICE_SCALE', 1) : null,
  noMask: process.env['PERF_NO_MASK'] === '1',
  antialiasOff: process.env['PERF_ANTIALIAS'] === 'off',
}

/**
 * PERF_ANTIALIAS=off: WebGL contexts are made without MSAA, whatever the
 * renderer asks (renderer/Canvas.tsx asks for `antialias: true`) — what
 * multisampling costs at a device scale, without touching the renderer.
 */
const ANTIALIAS_OFF = `(() => {
  const get = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl2' || type === 'webgl') attrs = { ...(attrs || {}), antialias: false }
    return get.call(this, type, attrs)
  }
})();`

/** The init scripts every page of a run gets besides the React hook. */
function extraInitScripts(): string[] {
  return PERF.antialiasOff ? [ANTIALIAS_OFF] : []
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

/**
 * The network under the browser, watched from the first context on: the
 * host's interfaces, failed requests, dropped WebSockets (README → Run
 * validity). One per process — a perf run is one Playwright worker.
 */
let monitor: NetworkMonitor | null = null
export function networkMonitor(): NetworkMonitor {
  monitor ??= new NetworkMonitor({ sockets: true, offline: true })
  return monitor
}

/**
 * PERF_SIMULATE_NETWORK_CHANGE: what a network change does to a page, as
 * near as Playwright gets without touching the machine's network — 50 ms
 * into the run the side's context goes offline for 300 ms with a request in
 * flight. Chromium's offline emulation fails it with
 * `net::ERR_INTERNET_DISCONNECTED` (a WebSocket stays up); a real
 * `ERR_NETWORK_CHANGED` cannot be produced from Playwright (neither
 * `route.abort` nor CDP's `Fetch.failRequest` has that reason). Detection
 * takes the same path for both: the context's `requestfailed`.
 */
function simulateNetworkChange(page: Page, what: string): void {
  if (isTauriPage(page))
    throw new Error('PERF_SIMULATE_NETWORK_CHANGE: the Tauri window has no offline switch')
  const context = page.context()
  void (async () => {
    await new Promise((r) => setTimeout(r, 50))
    console.log(`PERF simulate ${what}: the side offline for 300 ms, a request in flight`)
    await context.setOffline(true)
    try {
      await page.evaluate(() => {
        void fetch(`/api/health?perf-simulated-network-change=${Date.now()}`).catch(() => undefined)
      })
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      await context.setOffline(false)
    }
  })().catch((err: unknown) => console.log(`PERF simulate ${what} failed: ${String(err)}`))
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
    deviceScaleFactor: PERF.shell === 'browser' ? (PERF.deviceScale ?? 1) : 1,
  })
  await context.addInitScript(installReactPerfHook)
  for (const script of extraInitScripts()) await context.addInitScript(script)
  await networkMonitor().instrumentContext(context)
  return context
}

/**
 * The page a side measures in: a new page of `context`, or — `--shell tauri`
 * — the Tauri window on the side's origin (`context` then only seeds and
 * cleans up: its `request` posts the scene).
 */
export async function perfPage(
  context: BrowserContext,
  side: SideSpec,
  viewport: { width: number; height: number },
): Promise<Page> {
  if (PERF.shell === 'browser') return context.newPage()
  return tauriPage(context, {
    baseURL: side.baseURL,
    viewport,
    initScripts: extraInitScripts(),
    ...(PERF.deviceScale !== null ? { deviceScale: PERF.deviceScale } : {}),
  })
}

/** A bench the Tauri window cannot run, and why (null: it can). */
export function tauriCannot(id: string): string | null {
  if (PERF.shell !== 'tauri') return null
  if (id === 'present.presenter.window') return 'the presenter view is a second window'
  if (id.startsWith('deck.open.cold')) return 'a cold open needs a fresh profile per run'
  return null
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
  const dpr = await state.page.evaluate(() => window.devicePixelRatio)
  if (PERF.antialiasOff) {
    const aa = await state.page.evaluate(
      () =>
        document.createElement('canvas').getContext('webgl2')?.getContextAttributes()?.antialias,
    )
    if (aa !== false)
      throw new Error('PERF_ANTIALIAS=off did not take: a context still antialiases')
    console.log('PERF antialias off (every WebGL context without MSAA; results not stored)')
  }
  if (isTauriPage(state.page)) {
    // The system's WKWebView, in a window on the screen (always paced by the display).
    fp.browser = {
      name: 'webkit',
      version: systemWebKitVersion(),
      engine: 'webkit',
      shell: 'tauri',
      ...(dpr !== 1 ? { deviceScale: dpr } : {}),
    }
  } else {
    const name = browser.browserType().name()
    fp.browser = {
      name,
      version: browser.version(),
      engine: name === 'webkit' ? 'webkit' : name === 'firefox' ? 'gecko' : 'chromium',
      shell: 'browser',
      ...(PERF.headed ? { headed: true as const } : {}),
      ...(dpr !== 1 ? { deviceScale: dpr } : {}),
    }
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
    'present.ready',
    'present.dropped',
    'present.hitches',
    'frame.max',
    'advance.max',
    'longTask.max',
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
        // The attempts a network change disturbed and the run took again (README → Run validity).
        discarded: result.discarded ?? [],
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
    const lowPower = fp.power?.lowPowerMode === true
    if (PERF.lowPower && !lowPower)
      throw new Error('PERF_LOW_POWER=1 but Low Power Mode is off: switch it on for this run')
    // PERF_LOW_POWER=1: the cap is what this run measures.
    const refused = PERF.lowPower ? [] : refuseToRun(fp)
    if (refused.length > 0) throw new Error(`refusing to run: ${refused.join('; ')}`)
    if (PERF.lowPower)
      console.log('PERF Low Power Mode on, on purpose: results printed, not stored')
    fps.set(s, fp)
    for (const line of formatFingerprint(fp))
      console.log(`${line}${o.states.length > 1 ? ` [${s.side.name}]` : ''}`)
    if (!drawsFramePerInput(fp))
      console.log(
        'PERF note this runtime paces its frames apart from the input: perFrame counts ' +
          '(a drag’s sg.update, y.slideObjects.flush) are time metrics here, not budgeted',
      )
  }
  const keep = PERF.store && o.sceneIsDefault
  if (!o.sceneIsDefault) console.log('PERF scene knobs changed: results are printed, not stored')
  if (PERF.simulate.length > 0)
    console.log(
      `PERF simulating a network change in attempt ${PERF.simulate.join(', ')} of each bench ` +
        '(the side offline for 300 ms, a request in flight): results printed, not stored',
    )
  const network = networkMonitor()
  const verdicts: Verdict[] = []

  const failures: string[] = []
  for (const id of o.ids) {
    const cannot = tauriCannot(id)
    if (cannot !== null) {
      console.log(`PERF skipped ${id} in the Tauri window: ${cannot}`)
      continue
    }
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
      if (PERF.simulate.includes(n)) simulateNetworkChange(state.page, `${id} attempt ${n}`)
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
    // A run a network change touched measured a re-fetch or a reconnect:
    // discarded, and taken again once the network is quiet (README → Run validity).
    const guard: RunGuard = {
      retries: PERF.networkRetries,
      disturbances: (start, end) => network.touching(start, end),
      recover: () => network.recover(),
      onDiscard: (d) =>
        console.log(
          `PERF note ${id}: discarded ${d.phase === 'warmup' ? 'warm-up' : 'recorded'} run ${d.index}` +
            `${o.states.length > 1 && d.side !== undefined ? ` [${d.side}]` : ''} attempt ${d.attempt}` +
            `${d.error !== undefined ? ` (it threw: ${d.error})` : ''} — ${d.disturbances
              .slice(0, 3)
              .map((e) => `${clockTime(Date.parse(e.at))} ${e.source} ${e.detail}`)
              .join(
                '; ',
              )}${d.disturbances.length > 3 ? `; +${d.disturbances.length - 3} more` : ''}`,
        ),
    }
    const results = await runInterleaved(
      runDef,
      o.states.map((s) => ({ name: s.side.name, ctx: s, fingerprint: fps.get(s)! })),
      PERF.profile
        ? { warmup: 1, runs: 1, guard }
        : {
            warmup: PERF.warmupGiven ? PERF.warmup : (meta.runs?.warmup ?? PERF.warmup),
            runs: PERF.runsGiven ? PERF.runs : (meta.runs?.runs ?? PERF.runs),
            guard,
          },
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
      const discards = formatDiscards(id, result.discarded ?? [])
      if (discards !== null)
        console.log(`${discards}${o.states.length > 1 ? ` [${state.side.name}]` : ''}`)
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
          const baseDiscards = base.result.discarded?.length ?? 0
          if (baseDiscards > 0)
            console.log(
              `PERF note ${id}: its baseline (${base.result.at}) had ${baseDiscards} disturbed attempt${
                baseDiscards === 1 ? '' : 's'
              } discarded and re-run`,
            )
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
          // A display-paced run checks the per-move counts; its perFrame ones are timed.
          for (const line of formatBudgetCheck(
            id,
            diffBudget(meta.metrics, budget.counters, result),
          ))
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
