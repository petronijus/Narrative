/**
 * observability/sessionMetrics.ts — what real sessions measure (performance
 * plan G4 / S5).
 *
 * A sampled page session reports once, when the page is first hidden: the
 * document's navigation timing, the boot waterfall of the deck it opened
 * (state/loadTimings.ts: deck route mount → WebSocket connected → synced →
 * Pixi ready → first paint), its long tasks and its INP. The server folds
 * the report into `/metrics` histograms and logs it
 * (apps/server/src/routes/clientMetrics.ts; reading them: docs/ops.md
 * "Client session metrics").
 *
 * Privacy (@narrative/shared clientMetrics.ts): durations and counts only,
 * and a coarse route kind — no deck, user, URL or content. Not reported at
 * all: the render page (the render worker), a share-link visitor (no
 * session to send it with), the sign-in pages, and automated browsers
 * (`navigator.webdriver`: the e2e suite and the perf harness).
 *
 * Sampling: one draw per page session against
 * `VITE_CLIENT_METRICS_SAMPLE_RATE` (0–1, default 1: Narrative has few
 * users; lower it as they grow, 0 turns reporting off).
 */

import type { ClientMetricsReport, ClientMetricsRoute } from '@narrative/shared'
import type { LoadTimings } from '../state/loadTimings.js'

/** The bound every duration of a report respects (shared schema). */
const MAX_MS = 600_000
/** Entries kept per kind: a session longer than this keeps its first ones. */
const MAX_ENTRIES = 2000
/** web-vitals' threshold for `event` entries (ms). */
const EVENT_DURATION_THRESHOLD = 40
/** How long to look for the landing deck's load start (it is stamped on mount). */
const LANDING_DECK_WINDOW_MS = 30_000

/** The page kinds a report names; null = never report from this page. */
export function routeKind(pathname: string): ClientMetricsRoute | null {
  if (/^\/deck\/[^/]+\/render\/?$/.test(pathname)) return null
  if (/^\/folder\/[^/]+\/component\/[^/]+\/render\/?$/.test(pathname)) return null
  if (pathname.startsWith('/auth/')) return null
  if (/^\/deck\/[^/]+\/present\/?$/.test(pathname)) return 'present'
  if (/^\/deck\/[^/]+\/?$/.test(pathname)) return 'editor'
  if (pathname === '/' || /^\/folder\/[^/]+\/?$/.test(pathname)) return 'home'
  return 'other'
}

/**
 * INP as web-vitals estimates it: the longest interaction, or — so that one
 * outlier in a long session does not decide it — the (n / 50)-th longest
 * once there are 50 or more.
 */
export function estimateInp(
  longestPerInteraction: readonly number[],
  interactions: number,
): number | null {
  if (longestPerInteraction.length === 0) return null
  const desc = [...longestPerInteraction].sort((a, b) => b - a)
  const index = Math.min(desc.length - 1, Math.floor(interactions / 50))
  return desc[index] ?? null
}

/** Long-task time inside [from, to): each task clipped to the window. */
export function longTaskTimeWithin(
  tasks: readonly { start: number; duration: number }[],
  from: number,
  to: number,
): number {
  let total = 0
  for (const t of tasks) {
    const overlap = Math.min(t.start + t.duration, to) - Math.max(t.start, from)
    if (overlap > 0) total += overlap
  }
  return total
}

const clampMs = (v: number): number => Math.max(0, Math.min(MAX_MS, Math.round(v)))
const optionalMs = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : clampMs(v)

/** What the collector needs from the page; tests hand in their own. */
export interface SessionMetricsEnv {
  pathname: string
  /** The page carries a share-link token (an anonymous visitor, most often). */
  hasShareToken: boolean
  webdriver: boolean
  sampleRate: number
  random: () => number
  now: () => number
  /** Subscribe to performance entries of a type; returns the unsubscriber (null: unsupported). */
  observe: (
    type: 'longtask' | 'event',
    onEntries: (entries: readonly PerformanceEntry[]) => void,
  ) => (() => void) | null
  navigation: () => {
    ttfbMs: number | null
    fcpMs: number | null
    domContentLoadedMs: number | null
  }
  interactionCount: () => number | null
  /** A random id for this page session's report (crypto.randomUUID). */
  reportId: () => string
  readLoadTimings: () => LoadTimings | null
  /** Call `onHide` once the page is first hidden; returns the unsubscriber. */
  onFirstHide: (onHide: () => void) => () => void
  setInterval: (fn: () => void, ms: number) => () => void
  send: (report: ClientMetricsReport) => void
}

export interface SessionMetrics {
  /** Build the report now (tests, and the hide handler). */
  report(): ClientMetricsReport
  stop(): void
}

/** Start collecting; null when this session is not reported. */
export function startSessionMetrics(env: SessionMetricsEnv): SessionMetrics | null {
  const route = routeKind(env.pathname)
  if (route === null || env.webdriver || env.hasShareToken) return null
  if (!(env.random() < env.sampleRate)) return null

  const tasks: { start: number; duration: number }[] = []
  let taskCount = 0
  let taskTotal = 0
  let taskMax = 0
  const longestByInteraction = new Map<number, number>()

  const stops: (() => void)[] = []
  const stopTasks = env.observe('longtask', (entries) => {
    for (const e of entries) {
      taskCount++
      taskTotal += e.duration
      taskMax = Math.max(taskMax, e.duration)
      if (tasks.length < MAX_ENTRIES) tasks.push({ start: e.startTime, duration: e.duration })
    }
  })
  if (stopTasks) stops.push(stopTasks)
  const stopEvents = env.observe('event', (entries) => {
    for (const e of entries) {
      const id = (e as PerformanceEntry & { interactionId?: number }).interactionId ?? 0
      if (id === 0) continue
      const prev = longestByInteraction.get(id)
      if (prev === undefined && longestByInteraction.size >= MAX_ENTRIES) continue
      longestByInteraction.set(id, Math.max(prev ?? 0, e.duration))
    }
  })
  if (stopEvents) stops.push(stopEvents)

  // The landing deck's load start, to tell its (cold) open from a later
  // deck the page navigates to (warm): loadTimings keeps only the last one.
  let landingDeckStart: number | null = null
  if (route === 'editor' || route === 'present') {
    const startedAt = env.now()
    const look = (): void => {
      const t = env.readLoadTimings()
      if (t !== null) landingDeckStart = t.start
      if (t !== null || env.now() - startedAt > LANDING_DECK_WINDOW_MS) stopLook()
    }
    const stopLook = env.setInterval(look, 250)
    stops.push(stopLook)
    look()
  }

  const reportId = env.reportId()
  const report = (): ClientMetricsReport => {
    const t = env.readLoadTimings()
    const deckLoad: ClientMetricsReport['deckLoad'] =
      t === null
        ? null
        : {
            cold: landingDeckStart !== null && t.start === landingDeckStart,
            wsConnectedMs: optionalMs(t.wsConnectedMs),
            wsSyncedMs: optionalMs(t.wsSyncedMs),
            pixiReadyMs: optionalMs(t.pixiReadyMs),
            firstPaintMs: optionalMs(t.firstPaintMs),
            longTaskMs: clampMs(
              longTaskTimeWithin(
                tasks,
                t.start,
                t.firstPaintMs === null ? env.now() : t.start + t.firstPaintMs,
              ),
            ),
          }
    const nav = env.navigation()
    const interactions = env.interactionCount() ?? longestByInteraction.size
    return {
      v: 1,
      id: reportId,
      route,
      nav: {
        ttfbMs: optionalMs(nav.ttfbMs),
        fcpMs: optionalMs(nav.fcpMs),
        domContentLoadedMs: optionalMs(nav.domContentLoadedMs),
      },
      deckLoad,
      longTasks: {
        count: Math.min(taskCount, 100_000),
        totalMs: clampMs(taskTotal),
        maxMs: clampMs(taskMax),
      },
      inp: {
        interactions: Math.min(interactions, 100_000),
        inpMs: optionalMs(estimateInp([...longestByInteraction.values()], interactions)),
      },
    }
  }

  const stop = (): void => {
    for (const s of stops.splice(0)) s()
  }

  stops.push(
    env.onFirstHide(() => {
      const r = report()
      stop()
      env.send(r)
    }),
  )

  return { report, stop }
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

function sampleRateFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

/**
 * A v4 UUID. `crypto.randomUUID` exists only in secure contexts (https,
 * localhost); a page on plain http elsewhere builds one from
 * `getRandomValues`, which every context has.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The page's environment for `startSessionMetrics`. */
export function browserSessionMetricsEnv(opts: {
  apiUrl: string
  hasShareToken: boolean
  readLoadTimings: () => LoadTimings | null
}): SessionMetricsEnv {
  return {
    pathname: location.pathname,
    hasShareToken: opts.hasShareToken,
    webdriver: navigator.webdriver === true,
    sampleRate: sampleRateFromEnv(
      import.meta.env['VITE_CLIENT_METRICS_SAMPLE_RATE'] as string | undefined,
    ),
    random: Math.random,
    now: () => performance.now(),
    observe: (type, onEntries) => {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return null
      const observer = new PerformanceObserver((list) => onEntries(list.getEntries()))
      try {
        observer.observe({
          type,
          buffered: true,
          ...(type === 'event' ? { durationThreshold: EVENT_DURATION_THRESHOLD } : {}),
        } as PerformanceObserverInit)
      } catch {
        return null
      }
      return () => observer.disconnect()
    },
    navigation: () => {
      const nav = performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]
      return {
        ttfbMs: nav && nav.responseStart > 0 ? nav.responseStart : null,
        fcpMs: fcp ? fcp.startTime : null,
        domContentLoadedMs:
          nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null,
      }
    },
    interactionCount: () => {
      const n = (performance as Performance & { interactionCount?: number }).interactionCount
      return typeof n === 'number' ? n : null
    },
    reportId: randomUuid,
    readLoadTimings: opts.readLoadTimings,
    onFirstHide: (onHide) => {
      let done = false
      const handler = (): void => {
        if (done || document.visibilityState !== 'hidden') return
        done = true
        onHide()
      }
      // pagehide too: a navigation away does not always fire visibilitychange first.
      const onPageHide = (): void => {
        if (done) return
        done = true
        onHide()
      }
      document.addEventListener('visibilitychange', handler)
      window.addEventListener('pagehide', onPageHide)
      return () => {
        document.removeEventListener('visibilitychange', handler)
        window.removeEventListener('pagehide', onPageHide)
      }
    },
    setInterval: (fn, ms) => {
      const id = window.setInterval(fn, ms)
      return () => window.clearInterval(id)
    },
    send: (report) => {
      // keepalive: the request outlives the page that is going away.
      void fetch(`${opts.apiUrl}/client-metrics`, {
        method: 'POST',
        keepalive: true,
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(report),
      }).catch(() => {
        // Telemetry: a lost report is not worth a retry or a console line.
      })
    },
  }
}
