/**
 * loadSplit.ts — where a freshly loaded render page's "app ready" went
 * (ADR 0019, step 5: the measurement that decides between an in-place deck
 * switch and a slim render entry; docs/plans/performance.md, R1a / F5).
 *
 * After a new or recycled page installed its hooks, the worker reads the
 * page's own clocks once (`readLoadSnapshot`, run in the page) and turns them
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
 * Runs IN the page (`page.evaluate`): self-contained, no closures over this
 * module. Reads the navigation and resource timings and the deck's load
 * stamps; resource URLs are reduced to a kind here, inside the page.
 */
export function readLoadSnapshot(): LoadSnapshot {
  const origin = location.origin
  const kindOf = (name: string): ResourceKind => {
    let url: URL
    try {
      url = new URL(name)
    } catch {
      return 'other'
    }
    if (url.origin !== origin) return 'other'
    const p = url.pathname
    if (p.startsWith('/assets/')) {
      if (p.endsWith('.js')) return 'script'
      if (p.endsWith('.css')) return 'style'
      if (/\.(woff2?|ttf|otf)$/.test(p)) return 'font'
      return 'other'
    }
    if (p === '/api/auth/me') return 'auth'
    if (p.startsWith('/api/')) return 'api'
    if (p.startsWith('/storage/') || p.startsWith('/imgproxy/')) return 'media'
    return 'other'
  }
  const nav = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined
  const resources = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(
    (r) => ({ kind: kindOf(r.name), start: r.startTime, end: r.responseEnd }),
  )
  const timings = (
    window as unknown as {
      __narrative_perf?: {
        loadTimings?: { start: number; wsSyncedMs: number | null; pixiReadyMs: number | null }
      }
    }
  ).__narrative_perf?.loadTimings
  return {
    now: performance.now(),
    htmlEnd: nav !== undefined ? nav.responseEnd : null,
    resources,
    shellStart: timings !== undefined ? timings.start : null,
    wsSyncedMs: timings?.wsSyncedMs ?? null,
    pixiReadyMs: timings?.pixiReadyMs ?? null,
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
