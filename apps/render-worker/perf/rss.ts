/**
 * perf/rss.ts — resident memory of the stack's processes while a scenario
 * runs, for perf/render.ts (docs/plans/performance.md, R1).
 *
 * Two kinds of target:
 *
 *   - a process tree on this machine (`pid`): the process and every
 *     descendant — the render worker's Node and the Chromium it launched
 *     (browser, GPU, renderer and utility processes), the server's Node. The
 *     sum over-counts what Chromium's processes share (each RSS includes the
 *     shared pages it touched), so it is an upper bound, the same one on
 *     every run;
 *   - a container (`container`): what its cgroup holds (`docker stats`),
 *     the number VM 103's `mem_limit` is checked against.
 *
 * `findDevTargets` finds the dev stack's (`just dev`) render worker and server:
 * Node processes running `src/index.ts` whose working directory is
 * `apps/render-worker` / `apps/server`.
 */

import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type RssTarget = { name: string; pid: number } | { name: string; container: string }

export interface ProcessRow {
  pid: number
  ppid: number
  rssKb: number
}

/** `ps -axo pid=,ppid=,rss=` rows. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number)
    if (pid === undefined || ppid === undefined || rss === undefined) continue
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue
    rows.push({ pid, ppid, rssKb: rss })
  }
  return rows
}

/** RSS of `root` and all its descendants, in bytes (0 when `root` is gone). */
export function treeRssBytes(rows: readonly ProcessRow[], root: number): number {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const list = children.get(row.ppid)
    if (list === undefined) children.set(row.ppid, [row])
    else list.push(row)
  }
  const self = rows.find((r) => r.pid === root)
  if (self === undefined) return 0
  let total = 0
  const stack = [self]
  const seen = new Set<number>()
  while (stack.length > 0) {
    const row = stack.pop()!
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    total += row.rssKb * 1024
    stack.push(...(children.get(row.pid) ?? []))
  }
  return total
}

/** `docker stats` memory ("812.4MiB / 1.172GiB") in bytes. */
export function parseDockerMem(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(text)
  if (m === null) return null
  const unit = m[2]!.toUpperCase()
  const scale: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
  }
  const factor = scale[unit]
  return factor === undefined ? null : Number(m[1]) * factor
}

async function processRows(): Promise<ProcessRow[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 16 << 20 })
  return parsePs(stdout)
}

async function cwdOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => null)
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n'))
    return line === undefined ? null : line.slice(1)
  } catch {
    return null
  }
}

/** The dev stack's render worker and server processes (`just dev`), those found. */
export async function findDevTargets(): Promise<RssTarget[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 << 20 })
  const found: RssTarget[] = []
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m === null) continue
    const command = m[2]!
    // The app itself, not tsx's `watch` parent.
    if (
      !/\bnode\b/.test(command) ||
      !command.includes('src/index.ts') ||
      command.includes(' watch ')
    )
      continue
    const pid = Number(m[1])
    const cwd = await cwdOf(pid)
    if (cwd?.endsWith('/apps/render-worker') === true) found.push({ name: 'render-worker', pid })
    else if (cwd?.endsWith('/apps/server') === true) found.push({ name: 'server', pid })
  }
  return found
}

/** `PERF_RSS` ("render-worker=1234,server=container:narrative-server-1"), or the dev stack's. */
export async function rssTargetsFromEnv(value: string | undefined): Promise<RssTarget[]> {
  if (value === undefined || value.trim() === '') return findDevTargets()
  if (value.trim() === 'off') return []
  return value.split(',').map((part): RssTarget => {
    const [name, spec] = part.split('=') as [string, string | undefined]
    if (spec === undefined || name === '') throw new Error(`PERF_RSS: "${part}" is not name=pid`)
    if (spec.startsWith('container:')) return { name, container: spec.slice('container:'.length) }
    const pid = Number(spec)
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`PERF_RSS: "${spec}" is not a pid`)
    return { name, pid }
  })
}

async function containerBytes(container: string): Promise<number | null> {
  try {
    const { stdout } = await run('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{.MemUsage}}',
      container,
    ])
    return parseDockerMem(stdout)
  } catch {
    return null
  }
}

/**
 * Samples every target until `stop()`, which returns each one's peak in
 * bytes (null: never read). One sample at a time; `docker stats` takes about
 * a second per read, so a container's peak is the highest of those.
 */
export function sampleRss(
  targets: readonly RssTarget[],
  intervalMs = 250,
): { stop: () => Promise<Record<string, number | null>> } {
  const peaks: Record<string, number | null> = {}
  for (const t of targets) peaks[t.name] = null
  let running = true
  const loop = (async () => {
    while (running) {
      const started = Date.now()
      const needsPs = targets.some((t) => 'pid' in t)
      const rows = needsPs ? await processRows().catch(() => []) : []
      await Promise.all(
        targets.map(async (t) => {
          const bytes = 'pid' in t ? treeRssBytes(rows, t.pid) : await containerBytes(t.container)
          if (bytes === null || bytes === 0) return
          peaks[t.name] = Math.max(peaks[t.name] ?? 0, bytes)
        }),
      )
      const wait = intervalMs - (Date.now() - started)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
      return { ...peaks }
    },
  }
}

/** Bytes as MiB, one decimal. */
export function mib(bytes: number | null): string {
  return bytes === null ? 'n/a' : `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
