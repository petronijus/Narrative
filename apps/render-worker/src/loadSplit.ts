/**
 * loadSplit.ts — where a freshly loaded render page's "app ready" went
 * (ADR 0019, step 5: the measurement that decides between an in-place deck
 * switch and a slim render entry; docs/plans/performance.md, R1a / F5).
 *
 * After a new or recycled page installed its hooks, the worker reads the
 * page's own clocks once (`readPageLoadSnapshot`: an isolated world for the
 * native timings, the main world only for the load stamps) and turns them
 * into the critical path of the load (`loadSplit`), from the document's
 * navigation start:
 *
 *   html      the render page's HTML answered;
 *   scripts   the last script the app needed before the deck shell mounted
 *             (the entry, its vendor chunks and the route's lazy chunks,
 *             which load at boot: routePages.ts `preloadRoute`);
 *   boot      from there to the deck shell's mount (`markDeckLoadStart`,
 *             state/loadTimings.ts): evaluating the bundle, React's first
 *             renders and the session check the route guard waits for
 *             (`auth` says when that answered);
 *   pixi      the deck shell's mount → Pixi started (`markPixiReady`);
 *   inputs    the deck shell's mount → the page's hooks installed: the deck
 *             document synced (`synced`), its role, fonts and tokens read, the
 *             canvas ready — what any page, kept or new, has to wait for per
 *             deck. Pixi starts in parallel with it.
 *
 * Nothing of the page leaves as text: the snapshot is numbers and a fixed
 * kind per resource (no URL — those carry the render token and asset ids),
 * and the steps are `worker.load.<phase>` durations (the names the server
 * accepts, apps/server/src/render/jobTimings.ts).
 */

/** What a resource was, by its path on the app origin; never its URL. */
export type ResourceKind = 'script' | 'style' | 'font' | 'auth' | 'api' | 'media' | 'other'

export interface LoadSnapshot {
  /** `performance.now()` when the snapshot was taken (the hooks were just seen). */
  now: number
  /** The document's `responseEnd`; null without a navigation entry. */
  htmlEnd: number | null
  /** Resource timings: kind, start and end (ms since navigation start). */
  resources: Array<{ kind: ResourceKind; start: number; end: number }>
  /** The deck shell's mount, ms since navigation start; null when it never stamped. */
  shellStart: number | null
  /** Since the shell's mount (state/loadTimings.ts); null when not reached. */
  wsSyncedMs: number | null
  pixiReadyMs: number | null
}

/**
 * The page's native timings, evaluated in an ISOLATED world of the page
 * (`Page.createIsolatedWorld`): it shares the document but not the page's
 * JavaScript globals, so nothing the page's own code did to `performance`,
 * `Array`, `URL` or `String` shapes what is read. At most `max` resource
 * entries are taken — before any of them is mapped — and each is reduced to
 * a fixed kind there, so no URL (render token, asset ids) and nothing the page
 * sized leaves it. Plain JavaScript (`(max) => …`): it is sent as source.
 */
export const NATIVE_TIMINGS_SOURCE = `(max) => {
  const origin = location.origin
  const kindOf = (name) => {
    let url
    try { url = new URL(name) } catch { return 'other' }
    if (url.origin !== origin) return 'other'
    const p = url.pathname
    if (p.startsWith('/assets/')) {
      if (p.endsWith('.js')) return 'script'
      if (p.endsWith('.css')) return 'style'
      if (/\\.(woff2?|ttf|otf)$/.test(p)) return 'font'
      return 'other'
    }
    if (p === '/api/auth/me') return 'auth'
    if (p.startsWith('/api/')) return 'api'
    if (p.startsWith('/storage/') || p.startsWith('/imgproxy/')) return 'media'
    return 'other'
  }
  const nav = performance.getEntriesByType('navigation')[0]
  const entries = performance.getEntriesByType('resource').slice(0, max)
  const resources = []
  for (const r of entries) resources.push({ kind: kindOf(r.name), start: r.startTime, end: r.responseEnd })
  return { now: performance.now(), htmlEnd: nav !== undefined ? nav.responseEnd : null, resources }
}`

/**
 * The deck's load stamps (state/loadTimings.ts), evaluated in the page's MAIN
 * world — the only place they are. The page's code can make anything of
 * `window.__narrative_perf`, so this takes three readings and nothing else,
 * each a number or null (`typeof` cannot be redefined), into an object of its
 * own; a getter that throws gives null. Plain JavaScript, sent as source.
 */
export const LOAD_STAMPS_SOURCE = `() => {
  const num = (read) => { try { const v = read(); return typeof v === 'number' ? v : null } catch { return null } }
  let t = null
  try { const perf = window.__narrative_perf; t = perf != null ? perf.loadTimings : null } catch { t = null }
  if (t == null || (typeof t !== 'object' && typeof t !== 'function')) return { shellStart: null, wsSyncedMs: null, pixiReadyMs: null }
  return { shellStart: num(() => t.start), wsSyncedMs: num(() => t.wsSyncedMs), pixiReadyMs: num(() => t.pixiReadyMs) }
}`

/** What `readPageLoadSnapshot` needs of a CDP session (Playwright's `CDPSession`). */
export interface LoadSnapshotCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  detach(): Promise<void>
}

/** How long reading a page's load may take before it is given up on. */
const READ_TIMEOUT_MS = 2_000
/**
 * How long one evaluation may run in the page: below READ_TIMEOUT_MS, so V8
 * has stopped a script that never returns before the session is detached.
 */
const EVALUATE_TIMEOUT_MS = 1_500

/**
 * A page's load snapshot, read over CDP: the native timings in an isolated
 * world, the load stamps in the main world, both serialised by the browser
 * (`returnByValue`) and bounded in time (EVALUATE_TIMEOUT_MS per script,
 * READ_TIMEOUT_MS for the whole). Unknown on purpose: `loadSplit` checks it
 * again. Null when anything fails — the split is a log line, never a reason
 * to fail a job. Once given up on, the read sends nothing more, and the
 * session is detached whenever it opens.
 */
export async function readPageLoadSnapshot(
  openCdp: () => Promise<LoadSnapshotCdp>,
  limits: { readMs?: number; evaluateMs?: number } = {},
): Promise<unknown> {
  const readMs = limits.readMs ?? READ_TIMEOUT_MS
  const evaluateMs = limits.evaluateMs ?? EVALUATE_TIMEOUT_MS
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const opening = openCdp()
  const read = async (): Promise<unknown> => {
    const cdp = await opening
    const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (abandoned) return Promise.reject(new Error('the read was given up on'))
      return cdp.send(method, params)
    }
    const tree = (await send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
    const world = (await send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'narrative-load-split',
    })) as { executionContextId: number }
    const evaluate = async (expression: string, contextId?: number): Promise<unknown> => {
      const out = (await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        timeout: evaluateMs,
        ...(contextId !== undefined ? { contextId } : {}),
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (out.exceptionDetails !== undefined) throw new Error('the page threw')
      return out.result?.value
    }
    const native = await evaluate(
      `(${NATIVE_TIMINGS_SOURCE})(${MAX_RESOURCES})`,
      world.executionContextId,
    )
    const stamps = await evaluate(`(${LOAD_STAMPS_SOURCE})()`)
    if (typeof native !== 'object' || native === null) return null
    if (typeof stamps !== 'object' || stamps === null) return null
    // Each field from the world that may answer it, and nothing else.
    const n = native as Record<string, unknown>
    const m = stamps as Record<string, unknown>
    return {
      now: n['now'],
      htmlEnd: n['htmlEnd'],
      resources: n['resources'],
      shellStart: m['shellStart'],
      wsSyncedMs: m['wsSyncedMs'],
      pixiReadyMs: m['pixiReadyMs'],
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), readMs)
      }),
    ])
  } catch {
    return null
  } finally {
    abandoned = true
    clearTimeout(timer)
    // Also when the cap fired before the session opened: detached once it has.
    void opening.then((cdp) => cdp.detach()).catch(() => undefined)
  }
}

export interface LoadSplit {
  html: number
  scripts: number
  boot: number
  pixi: number | null
  inputs: number
  /** Absolute (from navigation start): when the session check answered; null without one. */
  auth: number | null
  /** Absolute: when the deck document synced; null when it had not. */
  synced: number | null
  /** Absolute: the whole load, navigation start → hooks seen. */
  total: number
  /** Scripts loaded before the shell mounted. */
  scriptCount: number
}

/** The longest clock reading taken from a page (a load past this is no load to split). */
const MAX_MS = 600_000
/** At most this many resource timings are read from a page's answer. */
const MAX_RESOURCES = 2_000
const KINDS: ReadonlySet<string> = new Set<ResourceKind>([
  'script',
  'style',
  'font',
  'auth',
  'api',
  'media',
  'other',
])

/** A page clock reading: finite, within [0, MAX_MS]; null otherwise. */
function clock(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_MS
    ? value
    : null
}

const round = (ms: number): number => Math.max(0, Math.round(ms))

/**
 * The load's critical path from a page's snapshot; null when the page never
 * reached the deck shell (nothing to split). The page runs the web app on
 * other people's content, so its answer is checked as data from outside:
 * readings that are no clock are dropped, as are resources of no known kind
 * and any past the first MAX_RESOURCES.
 */
export function loadSplit(snapshot: unknown): LoadSplit | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null
  const s = snapshot as Record<string, unknown>
  const shell = clock(s['shellStart'])
  const now = clock(s['now'])
  if (shell === null || now === null) return null
  const htmlEnd = clock(s['htmlEnd'])
  const html = htmlEnd !== null ? Math.min(htmlEnd, shell) : 0
  const resources: Array<{ kind: string; start: number; end: number }> = []
  if (Array.isArray(s['resources'])) {
    for (const r of (s['resources'] as unknown[]).slice(0, MAX_RESOURCES)) {
      if (typeof r !== 'object' || r === null) continue
      const { kind, start, end } = r as Record<string, unknown>
      const from = clock(start)
      const to = clock(end)
      if (typeof kind !== 'string' || !KINDS.has(kind) || from === null || to === null) continue
      resources.push({ kind, start: from, end: to })
    }
  }
  const before = resources.filter((r) => r.kind === 'script' && r.start < shell)
  const scriptsEnd = Math.min(
    shell,
    before.reduce((end, r) => Math.max(end, r.end), html),
  )
  const auth = resources.find((r) => r.kind === 'auth')
  const pixi = clock(s['pixiReadyMs'])
  const synced = clock(s['wsSyncedMs'])
  return {
    html: round(html),
    scripts: round(scriptsEnd - html),
    boot: round(shell - scriptsEnd),
    pixi: pixi !== null ? round(pixi) : null,
    inputs: round(now - shell),
    auth: auth !== undefined ? round(auth.end) : null,
    synced: synced !== null ? round(shell + synced) : null,
    total: round(now),
    scriptCount: before.length,
  }
}

/** The split as job steps (`RenderJobResult.timings`). */
export function loadSplitSteps(split: LoadSplit): Array<[string, number]> {
  const steps: Array<[string, number]> = [
    ['worker.load.html', split.html],
    ['worker.load.scripts', split.scripts],
    ['worker.load.boot', split.boot],
    ['worker.load.inputs', split.inputs],
  ]
  if (split.pixi !== null) steps.push(['worker.load.pixi', split.pixi])
  return steps
}

/** One log line's worth. */
export function formatLoadSplit(split: LoadSplit): string {
  const parts = [
    `html ${split.html}`,
    `scripts ${split.scripts} (${split.scriptCount})`,
    `boot ${split.boot}`,
    `inputs ${split.inputs}`,
    `pixi ${split.pixi ?? '-'}`,
    `auth@${split.auth ?? '-'}`,
    `synced@${split.synced ?? '-'}`,
    `total ${split.total}`,
  ]
  return parts.join(', ')
}
