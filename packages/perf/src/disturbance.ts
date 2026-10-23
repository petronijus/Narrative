/**
 * disturbance.ts — a run the machine disturbed, and what the harness does
 * with it (README → Statistics → Run validity).
 *
 * A network change under the browser — on the MacBook a USB-tethered phone
 * re-attaching about twice a minute — makes Chrome abort every request in
 * flight, `localhost` included, with `net::ERR_NETWORK_CHANGED`, and can drop
 * a WebSocket (Hocuspocus) that then reconnects and re-syncs. A bench sample
 * taken across one measured a re-fetch or a reconnect, not the gesture; an
 * e2e test that failed across one failed for the machine, not the code
 * (SETUP.md → Common first-run failures).
 *
 * The parts here are pure and shared by the perf driver
 * (apps/web/e2e/perf/lib/driver.ts) and the e2e fixture
 * (apps/web/e2e/fixtures/test.ts):
 *
 *   - `isNetworkChangeError`: a failed request's error text that means the
 *     network went away or changed, not that the server or the page failed;
 *   - `DisturbanceLog`: the events seen (browser- and host-side), and which
 *     of them touch a time window;
 *   - `guarded`: run one sample, discard it when it was disturbed, run it
 *     again — a bounded number of times, then fail loudly;
 *   - `retryVerdict`: whether an e2e test's retry may run (only when the
 *     failed attempt coincided with a network change).
 *
 * The host-side watcher (it polls the machine's network interfaces) is
 * `@narrative/perf/node` → networkWatch.ts.
 */

/** Who saw it: the browser (a failed request, a dropped socket), the host (an interface changed), or a simulation. */
export type DisturbanceSource = 'browser' | 'host' | 'simulated'

export interface Disturbance {
  /** Epoch ms. */
  at: number
  source: DisturbanceSource
  /** What was seen: `net::ERR_NETWORK_CHANGED GET http://…`, `en14 gone (172.16.42.2)`. */
  detail: string
}

/**
 * Error texts of a failed request that mean the network under the browser
 * changed — not a server error, not the page cancelling.
 */
const NETWORK_CHANGED: readonly RegExp[] = [
  // Chromium: the OS reported an IP address change; every socket is flushed.
  /\bERR_NETWORK_CHANGED\b/,
  // Chromium: the system suspended (sleep).
  /\bERR_NETWORK_IO_SUSPENDED\b/,
  // WebKit: NSURLErrorNetworkConnectionLost.
  /network connection was lost/i,
]

/** …and those of a network that is gone altogether (also what Playwright's setOffline and `route.abort('internetdisconnected')` produce). */
const OFFLINE: readonly RegExp[] = [
  /\bERR_INTERNET_DISCONNECTED\b/,
  // WebKit: NSURLErrorNotConnectedToInternet.
  /appears to be offline/i,
]

/**
 * Whether a failed request's error text says the network changed (or, with
 * `offline` — the default — went away). The e2e fixture passes
 * `offline: false`: specs take a context offline and abort requests with
 * `internetdisconnected` on purpose, and that must not pass for the machine's
 * doing. Nothing produces ERR_NETWORK_CHANGED but the OS.
 */
export function isNetworkChangeError(
  errorText: string | null | undefined,
  options: { offline?: boolean } = {},
): boolean {
  if (typeof errorText !== 'string') return false
  const patterns = options.offline === false ? NETWORK_CHANGED : [...NETWORK_CHANGED, ...OFFLINE]
  return patterns.some((re) => re.test(errorText))
}

export interface TouchMargin {
  /**
   * How long before a window an event still touches it: the effects of a
   * change play out after it — a dropped WebSocket reconnects after a backoff
   * of about a second, then re-syncs; a request aborted just before a test
   * started can be the route chunk the test waits for.
   */
  beforeMs: number
  /** How long after: the host watcher sees a change up to one poll late. */
  afterMs: number
}

export const TOUCH_MARGIN: TouchMargin = { beforeMs: 3000, afterMs: 500 }

/** The events of `events` within [start − before, end + after]. */
export function touching(
  events: readonly Disturbance[],
  start: number,
  end: number,
  margin: TouchMargin = TOUCH_MARGIN,
): Disturbance[] {
  return events.filter((e) => e.at >= start - margin.beforeMs && e.at <= end + margin.afterMs)
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** Local wall-clock time with milliseconds — what `log show` and configd print. */
export function clockTime(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** `12:01:44.123 browser net::ERR_NETWORK_CHANGED GET http://…`. */
export function formatDisturbance(d: Disturbance): string {
  return `${clockTime(d.at)} ${d.source} ${d.detail}`
}

/** A list of events in a line, the first few and how many more. */
export function summariseDisturbances(events: readonly Disturbance[], max = 3): string {
  const shown = events.slice(0, max).map(formatDisturbance).join('; ')
  return events.length > max ? `${shown}; +${events.length - max} more` : shown
}

/** The events seen during a run or a test, browser- and host-side. */
export class DisturbanceLog {
  private readonly events: Disturbance[] = []
  private readonly listeners = new Set<(d: Disturbance) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  record(source: DisturbanceSource, detail: string, at: number = this.now()): Disturbance {
    const d: Disturbance = { at, source, detail }
    // Kept in time order: the host watcher may report a change after a later browser event.
    let i = this.events.length
    while (i > 0 && this.events[i - 1]!.at > at) i--
    this.events.splice(i, 0, d)
    for (const l of this.listeners) l(d)
    return d
  }

  all(): readonly Disturbance[] {
    return this.events
  }

  touching(start: number, end: number, margin: TouchMargin = TOUCH_MARGIN): Disturbance[] {
    return touching(this.events, start, end, margin)
  }

  /** Called with every event as it is recorded; returns the unsubscribe. */
  subscribe(listener: (d: Disturbance) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Drop events older than `before` (a long e2e worker keeps only what a test can still ask for). */
  prune(before: number): void {
    let n = 0
    while (n < this.events.length && this.events[n]!.at < before) n++
    this.events.splice(0, n)
  }

  /** Ms since the newest event; Infinity when there is none. */
  quietFor(): number {
    const last = this.events.at(-1)
    return last === undefined ? Infinity : this.now() - last.at
  }

  /**
   * Resolve true once no event has been recorded for `quietMs`, false when
   * `timeoutMs` passes first (a network that never settles).
   */
  async waitQuiet(
    quietMs: number,
    timeoutMs: number,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<boolean> {
    const until = this.now() + timeoutMs
    for (;;) {
      const quiet = this.quietFor()
      if (quiet >= quietMs) return true
      const left = until - this.now()
      if (left <= 0) return false
      await sleep(Math.max(1, Math.min(quietMs - quiet, left)))
    }
  }
}

// ── WebSocket closes: which of them a network change explains ───────────────

/** The detail every socket-close disturbance starts with (`isNetworkSignal` leaves them out). */
export const SOCKET_CLOSE_DETAIL = 'WebSocket closed'

/** A WebSocket close as the page saw it (the perf driver's init script reports it). */
export interface SocketClose {
  /** Epoch ms. */
  at: number
  url: string
  /** The CloseEvent's code; absent where the page could not report it. */
  code?: number
  wasClean?: boolean
  /** Page code called `close()` on the socket before it closed. */
  byPage?: boolean
}

export type SocketCloseKind = 'orderly' | 'abnormal' | 'unknown'

/**
 * - `orderly`: the page closed it (`close()` — a provider destroyed when
 *   present mode switches documents, even one still connecting, whose event
 *   then says 1006), or the other end closed it with a close frame (1000
 *   normal, 1001 going away, 1011 or a 4xxx the server chose): somebody
 *   decided to, not the network;
 * - `abnormal`: no close frame (1006, `wasClean` false) and not the page's
 *   doing — the connection dropped under it;
 * - `unknown`: no CloseEvent was reported (a page without the init script).
 */
export function classifySocketClose(c: SocketClose): SocketCloseKind {
  if (c.byPage === true) return 'orderly'
  if (c.code === undefined && c.wasClean === undefined) return 'unknown'
  if (c.code === 1006 || c.wasClean === false) return 'abnormal'
  return 'orderly'
}

/** An event that says the network itself changed: the host's interfaces, a request that failed for it — not a socket close. */
export function isNetworkSignal(d: Disturbance): boolean {
  return !d.detail.startsWith(SOCKET_CLOSE_DETAIL)
}

/**
 * Whether a socket close disturbs the run: an abnormal one does (a dropped
 * connection reconnects and re-syncs); an unknown one only with a network
 * signal in `events` near it; an orderly one never — the page or the server
 * closing a socket is part of what a bench measures (present mode closing
 * a slide's document on a jump: 9 samples of `present.jump.link` discarded
 * before this rule, 2026-10-23).
 */
export function socketCloseDisturbs(
  c: SocketClose,
  events: readonly Disturbance[],
  margin: TouchMargin = TOUCH_MARGIN,
): boolean {
  const kind = classifySocketClose(c)
  if (kind === 'abnormal') return true
  if (kind === 'orderly') return false
  return touching(events.filter(isNetworkSignal), c.at, c.at, margin).length > 0
}

/** `WebSocket closed abnormally (1006): ws://localhost:3002/`. */
export function describeSocketClose(c: SocketClose, url: string = c.url): string {
  const kind = classifySocketClose(c)
  return kind === 'abnormal'
    ? `${SOCKET_CLOSE_DETAIL} abnormally (${c.code ?? '?'}${c.wasClean === false ? ', not clean' : ''}): ${url}`
    : `${SOCKET_CLOSE_DETAIL} (no close code reported) near a network change: ${url}`
}

// ── perf: discard a disturbed sample, run it again ─────────────────────────

/** A sample (or a warm-up run) that was disturbed and run again. Stored with the result. */
export interface DiscardedRun {
  /** The side of an interleaved run (A/B), when there are several. */
  side?: string
  phase: 'warmup' | 'run'
  /** 1-based: which warm-up run or recorded run of its side. */
  index: number
  /** 1-based: the attempt of that run that was discarded. */
  attempt: number
  /** ISO times the attempt started and ended. */
  start: string
  end: string
  /** The attempt's error, when the disturbance made it throw. */
  error?: string
  /** What disturbed it (epoch ms as ISO, source, detail). */
  disturbances: Array<{ at: string; source: DisturbanceSource; detail: string }>
}

export interface RunGuard {
  /**
   * What disturbed a run that spanned [start, end] (epoch ms) — [] when it
   * stands. Asked right after the run; it may first flush a watcher.
   */
  disturbances(start: number, end: number): Disturbance[] | Promise<Disturbance[]>
  /** Extra attempts one run may take before the bench fails (default `GUARD_RETRIES`). */
  retries?: number
  /** Before the next attempt: until the disturbance is over and the page has recovered. */
  recover?(seen: readonly Disturbance[]): Promise<void>
  /** Told about each discard as it happens (the driver prints a `PERF note`). */
  onDiscard?(d: DiscardedRun): void
  now?(): number
}

/** Extra attempts of one disturbed run (README → Run validity). */
export const GUARD_RETRIES = 3

/** A run stayed disturbed through every attempt: the bench fails rather than store tainted data. */
export class DisturbedRunError extends Error {
  constructor(
    readonly benchId: string,
    readonly discarded: readonly DiscardedRun[],
  ) {
    const last = discarded.at(-1)!
    super(
      `${benchId}: ${last.phase} run ${last.index}${last.side === undefined ? '' : ` [${last.side}]`} ` +
        `was disturbed in ${last.attempt} attempts in a row (last: ${last.disturbances
          .slice(0, 3)
          .map((d) => `${d.at} ${d.source} ${d.detail}`)
          .join('; ')}) — not storing tainted samples; ` +
        'find what changes the network (SETUP.md → Common first-run failures)',
    )
    this.name = 'DisturbedRunError'
  }
}

/**
 * Run one sample under `guard`: an attempt the guard calls disturbed is
 * discarded (appended to `discarded`, whether it returned or threw), the
 * guard's `recover` awaited, and the run attempted again — at most
 * `retries` more times, then `DisturbedRunError`. An undisturbed attempt's
 * error is the run's own and is rethrown at once. Without a guard the run
 * is simply run.
 */
export async function guarded<V>(
  benchId: string,
  run: () => Promise<V>,
  guard: RunGuard | undefined,
  slot: { side?: string; phase: 'warmup' | 'run'; index: number },
  discarded: DiscardedRun[],
): Promise<V> {
  if (guard === undefined) return run()
  const retries = guard.retries ?? GUARD_RETRIES
  const now = guard.now ?? Date.now
  const mine: DiscardedRun[] = []
  for (let attempt = 1; ; attempt++) {
    const start = now()
    let value: V | undefined
    let error: unknown
    let threw = false
    try {
      value = await run()
    } catch (err) {
      error = err
      threw = true
    }
    const end = now()
    const seen = await guard.disturbances(start, end)
    if (seen.length === 0) {
      if (threw) throw error
      return value as V
    }
    const d: DiscardedRun = {
      ...(slot.side !== undefined ? { side: slot.side } : {}),
      phase: slot.phase,
      index: slot.index,
      attempt,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      ...(threw
        ? { error: (error instanceof Error ? error.message : String(error)).split('\n')[0]! }
        : {}),
      disturbances: seen.map((e) => ({
        at: new Date(e.at).toISOString(),
        source: e.source,
        detail: e.detail,
      })),
    }
    mine.push(d)
    discarded.push(d)
    guard.onDiscard?.(d)
    if (attempt > retries) throw new DisturbedRunError(benchId, mine)
    await guard.recover?.(seen)
  }
}

/** `2 recorded runs discarded (network change) — 1 warm-up too`, or null when none was. */
export function formatDiscards(benchId: string, discarded: readonly DiscardedRun[]): string | null {
  if (discarded.length === 0) return null
  const runs = discarded.filter((d) => d.phase === 'run').length
  const warm = discarded.length - runs
  const sources = [...new Set(discarded.flatMap((d) => d.disturbances.map((e) => e.source)))]
  return (
    `PERF note ${benchId}: ${runs} sample${runs === 1 ? '' : 's'} discarded and re-run` +
    `${warm > 0 ? `, ${warm} warm-up run${warm === 1 ? '' : 's'} too` : ''}` +
    ` (a network change or a dropped connection, seen by: ${sources.join(', ')})`
  )
}

// ── e2e: retry a test only when its failure coincided with a network change ──

/** What a failed e2e attempt leaves for its retry (fixtures/test.ts writes it, the retry reads it). */
export interface FailedAttemptMarker {
  testId: string
  /** testInfo.retry of the failed attempt. */
  retry: number
  status: string
  /** ISO times of the attempt. */
  start: string
  end: string
  /** The network changes that touched it; [] = it failed on its own. */
  disturbances: Array<{ at: string; source: DisturbanceSource; detail: string }>
}

export type RetryVerdict = { run: true; because: string } | { run: false; because: string }

/**
 * Whether a retry attempt may run: only when the attempt before it failed
 * across a network change. Without its marker (the attempt failed before the
 * fixture could judge it — a `beforeAll`, a crashed worker) the failure is
 * taken as real: a retry never hides a failure nobody explained.
 */
export function retryVerdict(retry: number, previous: FailedAttemptMarker | null): RetryVerdict {
  if (retry === 0) return { run: true, because: 'first attempt' }
  if (previous === null)
    return {
      run: false,
      because: `attempt ${retry} failed before the network check could judge it: not retried`,
    }
  if (previous.disturbances.length === 0)
    return {
      run: false,
      because: `attempt ${retry} failed without a network change: not retried (its error is the real one)`,
    }
  const first = previous.disturbances[0]!
  return {
    run: true,
    because: `attempt ${retry} failed across a network change (${previous.disturbances.length} event${
      previous.disturbances.length === 1 ? '' : 's'
    }, first ${first.at} ${first.source} ${first.detail}): retried`,
  }
}
