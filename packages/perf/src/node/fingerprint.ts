/**
 * node/fingerprint.ts — the machine half of a Fingerprint, read in Node: git,
 * OS, CPU, load, Node, and on macOS the power source and Low Power Mode
 * (`pmset -g`). The browser layers add `browser` and `gl` to it.
 */

import { execFileSync } from 'node:child_process'
import os from 'node:os'
import type { BuildInfo, BuildSource, Fingerprint, PowerSource } from '../fingerprint.js'

/** Runs a program and returns its stdout, or null when it fails or is missing. */
export type Exec = (file: string, args: readonly string[], cwd?: string) => string | null

export const defaultExec: Exec = (file, args, cwd) => {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
  } catch {
    return null
  }
}

/**
 * The machine's directory name: NARRATIVE_PERF_MACHINE, else the host name
 * without its domain (`Petrs-MacBook-Pro.local` → `petrs-macbook-pro`), as
 * lowercase `[a-z0-9-]`.
 */
export function machineName(
  env: NodeJS.ProcessEnv = process.env,
  hostname = os.hostname(),
): string {
  const raw = env['NARRATIVE_PERF_MACHINE'] ?? hostname.split('.')[0] ?? hostname
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (name === '')
    throw new Error(`no usable machine name from '${raw}': set NARRATIVE_PERF_MACHINE`)
  return name
}

/** `pmset -g batt` → where the power comes from. */
export function parsePowerSource(batt: string): PowerSource {
  const m = /Now drawing from '([^']+)'/.exec(batt)
  if (m === null) return 'unknown'
  const s = m[1]!.toLowerCase()
  if (s.startsWith('battery')) return 'battery'
  if (s.startsWith('ups')) return 'ups'
  if (s.startsWith('ac')) return 'ac'
  return 'unknown'
}

/** `pmset -g` → Low Power Mode (the `lowpowermode` or `powermode` line), null when absent. */
export function parseLowPowerMode(settings: string): boolean | null {
  const m = /^\s*(?:lowpowermode|powermode)\s+(\d+)\s*$/m.exec(settings)
  if (m === null) return null
  // `powermode` (newer macOS): 0 automatic, 1 low power, 2 high power.
  return m[1] === '1'
}

export interface CollectOptions {
  build: BuildInfo
  /** The checkout whose sha is recorded (default: the working directory). */
  cwd?: string
  exec?: Exec
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export function collectFingerprint(options: CollectOptions): Fingerprint {
  const exec = options.exec ?? defaultExec
  const cwd = options.cwd ?? process.cwd()
  const sha = exec('git', ['rev-parse', 'HEAD'], cwd)?.trim()
  const status = exec('git', ['status', '--porcelain', '--untracked-files=normal'], cwd)
  const cpus = os.cpus()
  const [l1 = 0, l5 = 0, l15 = 0] = os.loadavg()
  let power: Fingerprint['power'] = null
  if (process.platform === 'darwin') {
    const batt = exec('pmset', ['-g', 'batt'])
    const settings = exec('pmset', ['-g'])
    power = {
      source: batt === null ? 'unknown' : parsePowerSource(batt),
      lowPowerMode: settings === null ? null : parseLowPowerMode(settings),
    }
  }
  return {
    machine: machineName(options.env),
    git:
      sha === undefined || sha === ''
        ? null
        : { sha, dirty: status !== null && status.trim() !== '' },
    build: options.build,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length },
    loadAvg: [l1, l5, l15],
    node: process.version,
    power,
    takenAt: (options.now ?? (() => new Date()))().toISOString(),
  }
}

/**
 * The build source of a deployed origin: its `/version.json` (written by the
 * web build, apps/web/vite.config.ts → emitVersionJson).
 */
export async function deployedSource(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BuildSource> {
  const url = new URL('/version.json', origin)
  const res = await fetchImpl(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`)
  const body = (await res.json()) as { version?: unknown }
  if (typeof body.version !== 'string' || body.version === '')
    throw new Error(`${url.href}: no version in ${JSON.stringify(body)}`)
  return { kind: 'deployed', origin: url.origin, version: body.version }
}
