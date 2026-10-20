/**
 * memory.ts — how much memory the worker's container has left, and the gate
 * a job passes before it opens a page beside another job's.
 *
 * The container's limit is small for Chromium (1200 MB on VM 103, against a
 * page of a photo-heavy slide that peaked at ~900 MB in 0.10.24 and a typical
 * 20-slide job at ~540 MB with the browser), and a kernel OOM kill takes the
 * GPU process and every job in the browser with it. So two jobs render at
 * once only while there is room for the second: a job that would open a page
 * waits until at least `reserveBytes` are free — idle kept pages are closed
 * first to make that room — or until it is the only job running, which may
 * always go ahead (that is the one-job worker as it was).
 *
 * Free memory is the container's: cgroup v2 `memory.max` − (`memory.current`
 * − `inactive_file`), the page cache the kernel drops before it kills
 * anything not counted as used. Outside a memory-limited cgroup (a developer
 * machine) there is nothing to read and the gate lets every job through.
 */

import { readFileSync } from 'node:fs'

/** Bytes the container may still use, or null when no cgroup limit applies. */
export function cgroupAvailableBytes(root = '/sys/fs/cgroup'): number | null {
  let max: string
  let current: string
  let stat: string
  try {
    max = readFileSync(`${root}/memory.max`, 'utf8').trim()
    current = readFileSync(`${root}/memory.current`, 'utf8').trim()
    stat = readFileSync(`${root}/memory.stat`, 'utf8')
  } catch {
    return null
  }
  if (max === 'max') return null
  const limit = Number(max)
  const used = Number(current)
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return null
  const inactive = Number(/^inactive_file (\d+)$/m.exec(stat)?.[1] ?? 0)
  return Math.max(0, limit - (used - inactive))
}

export interface MemoryGateOptions {
  /** Free bytes a further page needs before it opens beside another job's. */
  reserveBytes: number
  /** Free bytes now (null: no limit known — always room). */
  available: () => number | null
  /** Close one idle kept page to make room; false when there is none. */
  evictIdle: () => boolean
  /** How often a waiting job looks again. */
  pollMs?: number
  log: (message: string) => void
}

export class MemoryGate {
  /** Jobs that hold a page (or are opening one) right now. */
  private holders = 0

  constructor(private readonly opts: MemoryGateOptions) {}

  /**
   * Wait until this job may hold a page: at once when it is the only one,
   * or when `reserveBytes` are free (after closing idle pages); never past
   * `stopAt` — then it goes ahead only if it is alone by then, else throws.
   * Every successful `enter` is paired with one `leave`.
   */
  async enter(stopAt: number, what: string): Promise<void> {
    const pollMs = this.opts.pollMs ?? 200
    let waited = false
    for (;;) {
      if (this.holders === 0 || this.roomForOneMore()) {
        this.holders += 1
        if (waited) this.opts.log(`${what}: memory free again, rendering`)
        return
      }
      if (!waited) {
        waited = true
        this.opts.log(`${what}: waiting for memory (another job is rendering)`)
      }
      if (Date.now() >= stopAt) throw new MemoryWaitTimeout()
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  leave(): void {
    this.holders = Math.max(0, this.holders - 1)
  }

  get active(): number {
    return this.holders
  }

  /**
   * Room now; else one idle page is closed and the next look decides (its
   * memory comes back only once its renderer has gone, so one per look —
   * not every kept page at once for a reading that has not moved yet).
   */
  private roomForOneMore(): boolean {
    const free = this.opts.available()
    if (free === null || free >= this.opts.reserveBytes) return true
    this.opts.evictIdle()
    return false
  }
}

/** A job that waited for memory until its time was up. */
export class MemoryWaitTimeout extends Error {
  constructor() {
    super('waited for memory past the deadline (another job held it)')
  }
}
