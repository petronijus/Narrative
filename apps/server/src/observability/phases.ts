/**
 * observability/phases.ts — where one agent-surface request spends its time,
 * phase by phase (docs/plans/performance.md → G7; the probe is
 * apps/server/perf/agentLatency.ts, `just perf-agent`).
 *
 * Off unless a request asks for it (`timingPolicy`):
 *   - `SERVER_TIMING_KEY` set (≥ 16 characters): a request is timed when its
 *     `x-narrative-timing` header IS that key (compared in constant time) —
 *     the only way to time requests in production;
 *   - no key: outside production a request with `x-narrative-timing: 1` is
 *     timed (a developer's machine); in production nothing is;
 *   - `SERVER_TIMING=false` turns it off everywhere.
 * An untimed request costs one header read in its route's hooks; the marks
 * deeper down (ServerHost, the render service) cost one boolean check until
 * the first timed request of the process, and an AsyncLocalStorage lookup
 * after it. Nothing is allocated for an untimed request.
 *
 * A timed request carries a PhaseClock (AsyncLocalStorage, entered by the
 * transport: routes/agent.ts, mcp/routes.ts). Two kinds of entries:
 *   - laps: consecutive slices of the request's wall time since its
 *     `onRequest` (`http.pre`, `host`, `http.serialize`, `mcp.dispatch` …) —
 *     they add up to the server's whole time;
 *   - spans inside a lap (`host.admit`, `host.load`, `render.job` …),
 *     summed per name, which explain it.
 *
 * What a caller can learn (security review of G7, 2026-10-20):
 *   - everything before the route handler — the rate limiter (whose key
 *     resolves the credential), the body, the auth pre-handlers — is ONE
 *     opaque lap, `http.pre`: no slice of it says how a credential was
 *     checked;
 *   - nothing at all is reported until the ServerHost has authorised the
 *     call on its target (`phaseAuthorised`): a refused, unknown or
 *     forbidden target answers no phases, so timing tells nobody whether a
 *     deck exists;
 *   - nothing on a 401, 403 or 429 reply, whatever happened before;
 *   - names and durations are checked on the way out (`toJSON`): a name a
 *     dependency handed in (the render worker's steps) that is not a plain
 *     dotted token, or a duration that is not a finite non-negative number,
 *     is dropped, and at most MAX_REPORTED_PHASES go out.
 * Where they go: a `Server-Timing` response header on the command API, and
 * the tool result's `_meta["narrative/serverTiming"]` over MCP (its
 * streamable HTTP transport writes its headers before the tool runs).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { FastifyReply, FastifyRequest } from 'fastify'

/** The request header that asks for a request's phases. */
export const TIMING_REQUEST_HEADER = 'x-narrative-timing'

/** The key of the phases in an MCP tool result's `_meta`. */
export const MCP_TIMING_META_KEY = 'narrative/serverTiming'

/** A phase name that may leave the server: a dotted camelCase token. */
export const PHASE_NAME = /^[a-z][a-zA-Z0-9.]{0,63}$/

/** At most this many phases are reported for one request. */
export const MAX_REPORTED_PHASES = 64

/** Shortest `SERVER_TIMING_KEY` accepted. */
export const MIN_TIMING_KEY_LENGTH = 16

/** Replies that never carry phases, whatever ran before them. */
const SILENT_STATUSES: ReadonlySet<number> = new Set([401, 403, 429])

/** The phases of one timed request. */
export class PhaseClock {
  private readonly totals = new Map<string, number>()
  private mark: number
  private authorised = false

  constructor(start = performance.now()) {
    this.mark = start
  }

  /** Add `ms` to `phase` (a span: summed per name). */
  add(phase: string, ms: number): void {
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms)
  }

  /** The time since the previous lap (or the clock's start) goes to `phase`. */
  lap(phase: string, now = performance.now()): void {
    this.add(phase, now - this.mark)
    this.mark = now
  }

  /** The ServerHost authorised the call on its target: from now on the phases may be reported. */
  authorise(): void {
    this.authorised = true
  }

  /** May this request's phases be reported (see the file header)? */
  get reportable(): boolean {
    return this.authorised
  }

  /**
   * The phases that may leave the server, in the order first recorded:
   * valid names, finite non-negative durations, at most MAX_REPORTED_PHASES.
   */
  toJSON(): Record<string, number> {
    const out: Record<string, number> = {}
    let n = 0
    for (const [name, ms] of this.totals) {
      if (n >= MAX_REPORTED_PHASES) break
      if (!PHASE_NAME.test(name) || !Number.isFinite(ms) || ms < 0) continue
      out[name] = ms
      n++
    }
    return out
  }
}

/** Who may ask for phases (see the file header). */
export type TimingPolicy = { mode: 'off' } | { mode: 'dev' } | { mode: 'key'; digest: Buffer }

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()

/** The process's timing policy from its environment; throws on a key too short to be one. */
export function timingPolicy(env: NodeJS.ProcessEnv = process.env): TimingPolicy {
  if (env['SERVER_TIMING'] === 'false') return { mode: 'off' }
  const key = env['SERVER_TIMING_KEY']
  if (key !== undefined && key !== '') {
    if (key.length < MIN_TIMING_KEY_LENGTH)
      throw new Error(`SERVER_TIMING_KEY must be at least ${MIN_TIMING_KEY_LENGTH} characters`)
    return { mode: 'key', digest: sha256(key) }
  }
  return env['NODE_ENV'] === 'production' ? { mode: 'off' } : { mode: 'dev' }
}

const POLICY = timingPolicy()
const storage = new AsyncLocalStorage<PhaseClock>()
/** Set by the first timed request; until then every mark is one boolean check. */
let armed = false

/** Does this request ask to be timed, and may it be? A key is compared in constant time. */
export function wantsTiming(headers: IncomingHttpHeaders, policy: TimingPolicy = POLICY): boolean {
  if (policy.mode === 'off') return false
  const value = headers[TIMING_REQUEST_HEADER]
  if (typeof value !== 'string' || value === '') return false
  if (policy.mode === 'dev') return value === '1'
  // Digests of equal length: neither the key's length nor its prefix leaks.
  return timingSafeEqual(sha256(value), policy.digest)
}

/** Run `fn` with `clock` as the current request's clock; without one, just run it. */
export function runTimed<T>(clock: PhaseClock | null | undefined, fn: () => T): T {
  if (clock === null || clock === undefined) return fn()
  armed = true
  return storage.run(clock, fn)
}

/** The current request's clock, if it is timed. */
export function currentClock(): PhaseClock | undefined {
  return armed ? storage.getStore() : undefined
}

/** `performance.now()` when the current request is timed, else -1 (pass it to `phaseEnd`). */
export function phaseStart(): number {
  return armed && storage.getStore() !== undefined ? performance.now() : -1
}

/** Add the time since `start` (from `phaseStart`) to `phase` of the current request's clock. */
export function phaseEnd(phase: string, start: number): void {
  if (start < 0) return
  storage.getStore()?.add(phase, performance.now() - start)
}

/** Add `ms` measured elsewhere (another process: the render worker) to `phase` of the current request. */
export function phaseAdd(phase: string, ms: number): void {
  if (armed) storage.getStore()?.add(phase, ms)
}

/** The current request's next lap (see the file header); a no-op when it is not timed. */
export function phaseLap(phase: string): void {
  if (armed) storage.getStore()?.lap(phase)
}

/** The ServerHost authorised the current call on its target (see the file header). */
export function phaseAuthorised(): void {
  if (armed) storage.getStore()?.authorise()
}

/** The phases a reply may carry, or null when it may carry none. */
export function reportablePhases(
  clock: PhaseClock | null | undefined,
  status?: number,
): Record<string, number> | null {
  if (clock === null || clock === undefined || !clock.reportable) return null
  if (status !== undefined && SILENT_STATUSES.has(status)) return null
  return clock.toJSON()
}

/** `Server-Timing` (W3C): `name;dur=ms` per phase — only what `toJSON` lets out. */
export function serverTimingHeader(phases: Record<string, number>): string {
  return Object.entries(phases)
    .filter(([name, ms]) => PHASE_NAME.test(name) && Number.isFinite(ms) && ms >= 0)
    .slice(0, MAX_REPORTED_PHASES)
    .map(([name, ms]) => `${name};dur=${ms.toFixed(3)}`)
    .join(', ')
}

/** Parse a `Server-Timing` header back into phases (the probe's side). */
export function parseServerTiming(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  if (header === null || header === undefined || header === '') return out
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';')
    if (name === undefined || name === '') continue
    const dur = params.map((p) => p.trim()).find((p) => p.startsWith('dur='))
    out[name] = dur === undefined ? 0 : Number(dur.slice(4))
  }
  return out
}

// ---------------------------------------------------------------------------
// Fastify: the route-level hooks of a timed route
// ---------------------------------------------------------------------------

const clocks = new WeakMap<FastifyRequest, PhaseClock>()

/** The clock of a timed Fastify request, else null. */
export function requestClock(req: FastifyRequest): PhaseClock | null {
  return clocks.get(req) ?? null
}

/**
 * Hooks to spread into a route's options. `onRequest` starts the clock of a
 * request that asks for one. The handler laps `http.pre` when it starts
 * (everything before it, as one opaque slice) and runs its work under
 * `runTimed(requestClock(req), …)`. `onSend` closes `http.serialize` and
 * writes `Server-Timing` — for an authenticated caller whose call the
 * ServerHost authorised, never on a 401, 403 or 429 (see the file header).
 */
export const timingHooks = {
  onRequest: async (req: FastifyRequest): Promise<void> => {
    if (wantsTiming(req.headers)) clocks.set(req, new PhaseClock())
  },
  onSend: async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    const clock = clocks.get(req)
    if (clock === undefined || req.user === undefined) return payload
    clock.lap('http.serialize')
    const phases = reportablePhases(clock, reply.statusCode)
    if (phases !== null) void reply.header('server-timing', serverTimingHeader(phases))
    return payload
  },
}
