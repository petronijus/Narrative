/**
 * node/store.ts — this machine's results and baselines, local like
 * tests/load's (docs/plans/perf-harness.md → Commands):
 *
 *   ~/.cache/narrative-perf/<machine>/results.jsonl     every result, append-only
 *   ~/.cache/narrative-perf/<machine>/baselines.json    the accepted baseline per bench
 *   ~/.cache/narrative-perf/<machine>/baselines.history.jsonl
 *                                                       every baseline an accept replaced
 *
 * `$XDG_CACHE_HOME` replaces `~/.cache` when set; NARRATIVE_PERF_HOME
 * replaces the whole `…/narrative-perf` (the tests use a temp dir). Nothing is
 * lost on accept: the replaced baseline goes to the history file first, and
 * baselines.json is written to a temp file and renamed over the old one.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BuildMode, Fingerprint } from '../fingerprint.js'
import { RESULT_FORMAT, type BenchResult } from '../result.js'

export const BASELINES_FORMAT = 1

export interface Baseline {
  acceptedAt: string
  result: BenchResult
}

export interface Baselines {
  format: typeof BASELINES_FORMAT
  machine: string
  /** By baselineKey: one series per bench, build mode and browser/shell. */
  benches: Record<string, Baseline>
}

/**
 * The series a result belongs to: `<bench>@<mode>/<runtime>` — a dev, a prod
 * and a profiling build each keep their own baseline, as do Chromium, WebKit
 * and the desktop shells (`fill.solid.mount@prod/chromium-browser`).
 */
export function baselineKey(benchId: string, fp: Pick<Fingerprint, 'build' | 'browser'>): string {
  const runtime = fp.browser === undefined ? 'node' : `${fp.browser.engine}-${fp.browser.shell}`
  return `${benchId}@${fp.build.mode}/${runtime}`
}

export function perfHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env['NARRATIVE_PERF_HOME'] !== undefined && env['NARRATIVE_PERF_HOME'] !== '')
    return env['NARRATIVE_PERF_HOME']
  const cache =
    env['XDG_CACHE_HOME'] !== undefined && env['XDG_CACHE_HOME'] !== ''
      ? env['XDG_CACHE_HOME']
      : path.join(os.homedir(), '.cache')
  return path.join(cache, 'narrative-perf')
}

export interface LatestFilter {
  mode?: BuildMode
  engine?: NonNullable<Fingerprint['browser']>['engine']
}

export interface ResultStore {
  readonly dir: string
  readonly machine: string
  append(result: BenchResult): void
  /** Every stored result, oldest first; a line that does not parse is reported, never skipped silently. */
  results(filter?: { benchId?: string }): BenchResult[]
  /** The newest stored result of a bench (of one build mode / browser engine when asked), or undefined. */
  latest(benchId: string, filter?: LatestFilter): BenchResult | undefined
  /** The newest result of each series (baselineKey) of a bench. */
  latestPerSeries(benchId: string): BenchResult[]
  baselines(): Baselines
  /** The baseline of the series `result` belongs to (baselineKey), or undefined. */
  baselineFor(result: Pick<BenchResult, 'benchId' | 'fingerprint'>): Baseline | undefined
  /** Make `result` its series' baseline on this machine; returns the baseline it replaced. */
  accept(result: BenchResult, now?: Date): Baseline | undefined
}

function checkResult(r: unknown, where: string): BenchResult {
  const o = r as Partial<BenchResult> | null
  if (
    o === null ||
    typeof o !== 'object' ||
    o.format !== RESULT_FORMAT ||
    typeof o.benchId !== 'string'
  )
    throw new Error(`${where}: not a result of format ${RESULT_FORMAT}`)
  return o as BenchResult
}

export function openResultStore(options: { machine: string; home?: string }): ResultStore {
  const dir = path.join(options.home ?? perfHome(), options.machine)
  const resultsFile = path.join(dir, 'results.jsonl')
  const baselinesFile = path.join(dir, 'baselines.json')
  const historyFile = path.join(dir, 'baselines.history.jsonl')
  const ensureDir = (): void => void mkdirSync(dir, { recursive: true })
  const mine = (r: BenchResult, what: string): void => {
    if (r.fingerprint.machine !== options.machine)
      throw new Error(
        `${what}: a result of machine ${r.fingerprint.machine}, this store is ${options.machine}'s`,
      )
  }

  const store: ResultStore = {
    dir,
    machine: options.machine,
    append(result) {
      mine(result, 'append')
      ensureDir()
      appendFileSync(resultsFile, JSON.stringify(checkResult(result, 'append')) + '\n')
    },
    results(filter) {
      if (!existsSync(resultsFile)) return []
      return readFileSync(resultsFile, 'utf8')
        .split('\n')
        .flatMap((line, i) => {
          if (line.trim() === '') return []
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch (e) {
            throw new Error(`${resultsFile}:${i + 1}: not JSON (${(e as Error).message})`, {
              cause: e,
            })
          }
          const r = checkResult(parsed, `${resultsFile}:${i + 1}`)
          return filter?.benchId === undefined || r.benchId === filter.benchId ? [r] : []
        })
    },
    latest(benchId, filter) {
      return store
        .results({ benchId })
        .filter(
          (r) =>
            (filter?.mode === undefined || r.fingerprint.build.mode === filter.mode) &&
            (filter?.engine === undefined || r.fingerprint.browser?.engine === filter.engine),
        )
        .at(-1)
    },
    latestPerSeries(benchId) {
      const bySeries = new Map<string, BenchResult>()
      for (const r of store.results({ benchId }))
        bySeries.set(baselineKey(benchId, r.fingerprint), r)
      return [...bySeries.values()]
    },
    baselines() {
      if (!existsSync(baselinesFile))
        return { format: BASELINES_FORMAT, machine: options.machine, benches: {} }
      const b = JSON.parse(readFileSync(baselinesFile, 'utf8')) as Baselines
      if (b.format !== BASELINES_FORMAT || b.machine !== options.machine)
        throw new Error(
          `${baselinesFile}: format ${b.format} of machine ${b.machine}, expected ${BASELINES_FORMAT} of ${options.machine}`,
        )
      return b
    },
    baselineFor(result) {
      return store.baselines().benches[baselineKey(result.benchId, result.fingerprint)]
    },
    accept(result, now = new Date()) {
      mine(result, 'accept')
      checkResult(result, 'accept')
      const current = store.baselines()
      const key = baselineKey(result.benchId, result.fingerprint)
      const previous = current.benches[key]
      ensureDir()
      if (previous !== undefined)
        appendFileSync(
          historyFile,
          JSON.stringify({ key, replacedAt: now.toISOString(), ...previous }) + '\n',
        )
      current.benches[key] = { acceptedAt: now.toISOString(), result }
      const tmp = `${baselinesFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n')
      renameSync(tmp, baselinesFile)
      return previous
    },
  }
  return store
}
