/**
 * cli/run.ts — `just perf`, `just perf-compare`, `just perf-bisect`,
 * `just perf-profile` (docs/plans/perf-harness.md → Commands): builds what a
 * mode needs, serves it, and runs the layer I scenarios in Playwright
 * (apps/web/e2e/perf, which stores, compares and prints — lib/driver.ts).
 *
 *   perf [ids…] [--mode dev|prod|profiling] [--layer I|C] [--runs N] [--warmup N]
 *        [--browser chromium|webkit] [--no-build] [--swiftshader]
 *   perf-compare <revA> <revB> [ids…] [--runs N]   (`.` = this working tree)
 *   perf-bisect <id> <good> <bad> [--runs N]
 *   perf-profile <id> [--mode profiling|prod|dev]
 *
 * The mode defaults to prod (the build people use; perf-harness.md →
 * Commands). dev runs against the Vite dev server of `just dev` (:5173); prod and
 * profiling build apps/web into dist-perf-<mode> and serve it with `vite
 * preview` on a free port in front of the same dev backend (node/webBuild.ts).
 * Chromium draws with the machine's GPU (Metal / Vulkan through ANGLE); with
 * `--swiftshader` in software, as headless Chromium does by default — work
 * counts are the same either way, timings are not, and a crowded slide on
 * SwiftShader takes minutes per drag on a busy machine.
 * `--layer C` runs every bench with work counters, two runs each, in dev —
 * the counter gate of `just ci` (then `perf counters` compares the budgets).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILD_MODES, type BuildMode } from '../fingerprint.js'
import { repoRoot } from '../node/budgetFiles.js'
import { perfHome } from '../node/store.js'
import {
  buildWeb,
  builtVersion,
  reachable,
  startPreview,
  type BuiltMode,
  type Preview,
} from '../node/webBuild.js'
import { checkout, commitsBetween, WORKING_TREE, type Checkout } from '../node/worktrees.js'
import { benchRegistry } from './checks.js'

interface Args {
  positional: string[]
  flags: Map<string, string | true>
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined]
      if (v !== undefined) flags.set(k, v)
      else if (['mode', 'layer', 'runs', 'warmup', 'browser'].includes(k) && i + 1 < argv.length)
        flags.set(k, argv[++i]!)
      else flags.set(k, true)
    } else positional.push(a)
  }
  return { positional, flags }
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name)
  return typeof v === 'string' ? v : undefined
}

function mode(args: Args, fallback: BuildMode): BuildMode {
  const m = flag(args, 'mode') ?? fallback
  if (!(BUILD_MODES as readonly string[]).includes(m))
    throw new Error(`--mode ${m}: one of ${BUILD_MODES.join(', ')}`)
  return m as BuildMode
}

const log = (line: string): void => console.log(`PERF ${line}`)

/** The layer I bench ids to run: named ones (checked), else every one of the layer(s). */
export function resolveIds(named: readonly string[], layer: string | undefined): string[] {
  const registry = benchRegistry()
  for (const id of named) if (!registry.has(id)) throw new Error(`no bench ${id}`)
  if (named.length > 0) return [...named]
  const all = registry.list({ layer: ['I'] })
  if (layer === 'C')
    return all
      .filter((b) => Object.values(b.metrics).some((m) => m.kind === 'work'))
      .map((b) => b.id)
  return all.map((b) => b.id)
}

interface PlaywrightRun {
  ids: readonly string[]
  mode: BuildMode
  sides: Array<{ name: string; baseURL: string; version?: string; rev?: string }>
  browser: 'chromium' | 'webkit'
  env?: NodeJS.ProcessEnv
}

/** Run the perf specs; resolves with Playwright's exit code. */
function playwright(root: string, o: PlaywrightRun): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PERF_RUN: '1',
    PERF_IDS: o.ids.join(','),
    PERF_MODE: o.mode,
    PERF_SIDES: JSON.stringify(o.sides),
    PW_BASE_URL: o.sides[0]!.baseURL,
    // The machine's GPU unless a caller says otherwise (--swiftshader).
    PERF_GPU: '1',
    ...(o.browser === 'webkit' ? { PW_WEBKIT: '1' } : {}),
    ...o.env,
  }
  const project = o.browser === 'webkit' ? 'perf-webkit' : 'perf'
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', 'e2e/perf', `--project=${project}`],
      {
        cwd: path.join(root, 'apps', 'web'),
        env,
        stdio: 'inherit',
      },
    )
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function requireDevBackend(): Promise<void> {
  if (!(await reachable('http://localhost:3001/health')))
    throw new Error('the dev backend (:3001) does not answer: start `just dev`')
}

/** A build of `co` in `m`, served; dev is the running Vite dev server. */
async function serve(
  co: Checkout,
  m: BuildMode,
  build: boolean,
): Promise<{ url: string; version?: string; preview?: Preview }> {
  if (m === 'dev') {
    if (!(await reachable('http://localhost:5173/')))
      throw new Error('the Vite dev server (:5173) does not answer: start `just dev`')
    return { url: 'http://localhost:5173' }
  }
  const outDir = path.join(co.webDir, `dist-perf-${m}`)
  if (build || !existsSync(path.join(outDir, 'index.html'))) {
    log(
      `building ${m} of ${co.rev === WORKING_TREE ? 'the working tree' : co.sha.slice(0, 10)} → ${outDir}`,
    )
    const t = Date.now()
    await buildWeb(co.webDir, m as BuiltMode)
    log(`built in ${((Date.now() - t) / 1000).toFixed(0)} s`)
  }
  const preview = await startPreview(co.webDir, m as BuiltMode)
  log(`serving ${m} on ${preview.url}`)
  const version = builtVersion(outDir)
  return { url: preview.url, ...(version !== undefined ? { version } : {}), preview }
}

async function perf(args: Args): Promise<number> {
  const root = repoRoot()
  const layer = flag(args, 'layer')
  const m = layer === 'C' ? 'dev' : mode(args, 'prod')
  const browser = (flag(args, 'browser') ?? 'chromium') as 'chromium' | 'webkit'
  const ids = resolveIds(args.positional, layer)
  await requireDevBackend()
  const co = await checkout(root, WORKING_TREE, perfHome())
  const s = await serve(co, m, !args.flags.has('no-build'))
  try {
    return await playwright(root, {
      ids,
      mode: m,
      browser,
      sides: [
        { name: m, baseURL: s.url, ...(s.version !== undefined ? { version: s.version } : {}) },
      ],
      env: {
        ...(layer === 'C' ? { PERF_RUNS: '2', PERF_WARMUP: '1' } : {}),
        ...(flag(args, 'runs') !== undefined ? { PERF_RUNS: flag(args, 'runs') } : {}),
        ...(flag(args, 'warmup') !== undefined ? { PERF_WARMUP: flag(args, 'warmup') } : {}),
        ...(args.flags.has('swiftshader') ? { PERF_GPU: '0' } : {}),
      },
    })
  } finally {
    await s.preview?.stop()
  }
}

interface VerdictRow {
  bench: string
  regressions: string[]
  improvements: string[]
  counterChanges: string[]
}

/** Build both revisions (prod), run them interleaved; resolves with the verdicts. */
async function compareRevs(
  root: string,
  revA: string,
  revB: string,
  ids: readonly string[],
  runs: string | undefined,
): Promise<{ code: number; verdicts: VerdictRow[] }> {
  await requireDevBackend()
  const a = await checkout(root, revA, perfHome(), log)
  const b = await checkout(root, revB, perfHome(), log)
  const sa = await serve(a, 'prod', true)
  const sb = await serve(b, 'prod', true)
  const verdictFile = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'narrative-perf-')),
    'verdicts.json',
  )
  try {
    const code = await playwright(root, {
      ids,
      mode: 'prod',
      browser: 'chromium',
      sides: [
        {
          name: `A ${revA}`,
          baseURL: sa.url,
          rev: a.sha,
          ...(sa.version !== undefined ? { version: sa.version } : {}),
        },
        {
          name: `B ${revB}`,
          baseURL: sb.url,
          rev: b.sha,
          ...(sb.version !== undefined ? { version: sb.version } : {}),
        },
      ],
      env: { PERF_VERDICT_FILE: verdictFile, ...(runs !== undefined ? { PERF_RUNS: runs } : {}) },
    })
    const verdicts = existsSync(verdictFile)
      ? (JSON.parse(readFileSync(verdictFile, 'utf8')) as VerdictRow[])
      : []
    return { code, verdicts }
  } finally {
    await sa.preview?.stop()
    await sb.preview?.stop()
  }
}

function printVerdicts(verdicts: readonly VerdictRow[]): boolean {
  let regressed = false
  for (const v of verdicts) {
    const parts = [
      v.regressions.length > 0 ? `REGRESSION ${v.regressions.join(', ')}` : '',
      v.improvements.length > 0 ? `improvement ${v.improvements.join(', ')}` : '',
      v.counterChanges.length > 0 ? `counters changed: ${v.counterChanges.join(', ')}` : '',
    ].filter((p) => p !== '')
    log(`verdict ${v.bench}: ${parts.join(' · ') || 'no change'}`)
    if (v.regressions.length > 0 || v.counterChanges.length > 0) regressed = true
  }
  return regressed
}

async function compareCmd(args: Args): Promise<number> {
  const [revA, revB, ...named] = args.positional
  if (revA === undefined || revB === undefined)
    throw new Error('usage: perf-compare <revA> <revB> [ids…]')
  const root = repoRoot()
  const { code, verdicts } = await compareRevs(
    root,
    revA,
    revB,
    resolveIds(named, undefined),
    flag(args, 'runs'),
  )
  if (code !== 0) return code
  return printVerdicts(verdicts) ? 1 : 0
}

async function bisectCmd(args: Args): Promise<number> {
  const [id, good, bad] = args.positional
  if (id === undefined || good === undefined || bad === undefined)
    throw new Error('usage: perf-bisect <id> <good> <bad>')
  resolveIds([id], undefined)
  const root = repoRoot()
  const commits = await commitsBetween(root, good, bad)
  if (commits.length === 0) throw new Error(`no commits between ${good} and ${bad}`)
  // Binary search for the first commit that regresses against `good`.
  let lo = 0
  let hi = commits.length - 1
  let firstBad: string | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const sha = commits[mid]!
    log(`bisect ${id}: ${good} vs ${sha.slice(0, 10)} (${hi - lo + 1} candidates)`)
    const { code, verdicts } = await compareRevs(root, good, sha, [id], flag(args, 'runs'))
    if (code !== 0) throw new Error(`perf-compare failed at ${sha} (exit ${code})`)
    if (printVerdicts(verdicts)) {
      firstBad = sha
      hi = mid - 1
    } else lo = mid + 1
  }
  if (firstBad === null) {
    log(`bisect ${id}: no commit in ${good}..${bad} regresses against ${good}`)
    return 0
  }
  log(`bisect ${id}: first regressing commit ${firstBad}`)
  return 1
}

async function profileCmd(args: Args): Promise<number> {
  const [id] = args.positional
  if (id === undefined) throw new Error('usage: perf-profile <id> [--mode profiling|prod|dev]')
  resolveIds([id], undefined)
  const root = repoRoot()
  const m = mode(args, 'profiling')
  await requireDevBackend()
  const co = await checkout(root, WORKING_TREE, perfHome())
  const s = await serve(co, m, !args.flags.has('no-build'))
  try {
    return await playwright(root, {
      ids: [id],
      mode: m,
      browser: 'chromium',
      sides: [
        { name: m, baseURL: s.url, ...(s.version !== undefined ? { version: s.version } : {}) },
      ],
      env: {
        PERF_PROFILE: '1',
        PERF_STORE: '0',
        ...(args.flags.has('swiftshader') ? { PERF_GPU: '0' } : {}),
      },
    })
  } finally {
    await s.preview?.stop()
  }
}

export const RUN_COMMANDS: Record<string, (args: Args) => Promise<number>> = {
  run: perf,
  compare: compareCmd,
  bisect: bisectCmd,
  profile: profileCmd,
}
