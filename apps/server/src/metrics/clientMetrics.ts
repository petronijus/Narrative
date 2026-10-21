/**
 * apps/server/src/metrics/clientMetrics.ts
 *
 * The editor's session reports (performance plan G4 / S5): the boot
 * waterfall of a deck open (deck route mount → WebSocket connected → synced
 * → Pixi ready → first paint), navigation timing, long tasks and INP of
 * real sessions, sampled in the browser
 * (apps/web/src/observability/sessionMetrics.ts).
 *
 * The route that receives them is routes/clientMetrics.ts. Each report is folded into in-process Prometheus histograms, rendered by
 * `/metrics` (metrics/collectors.ts), and logged as one structured line
 * (`client session metrics`), so the numbers are readable with or without a
 * scraper: `tools/ops/client-metrics.py` turns either into percentiles
 * (docs/ops.md "Client session metrics"). The histograms live in memory: a
 * restart starts them from zero, the log lines stay.
 *
 * Privacy: the report schema carries durations and counts only, bounded, and
 * a coarse route kind (closed enums are the only label values, so the series
 * count is fixed).
 */

import {
  CLIENT_METRICS_COUNT_BUCKETS,
  CLIENT_METRICS_INTERACTION_BUCKETS,
  CLIENT_METRICS_MS_BUCKETS,
  type ClientMetricsReport,
} from '@narrative/shared'

type Labels = Record<string, string>

/** A Prometheus histogram per label set (cumulative buckets on render). */
class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: readonly number[],
  ) {}

  observe(value: number, labels: Labels): void {
    const key = JSON.stringify(labels)
    let s = this.series.get(key)
    if (s === undefined) {
      s = { labels, counts: new Array<number>(this.bounds.length + 1).fill(0), sum: 0 }
      this.series.set(key, s)
    }
    let i = this.bounds.findIndex((b) => value <= b)
    if (i === -1) i = this.bounds.length
    s.counts[i] = (s.counts[i] ?? 0) + 1
    s.sum += value
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    const sorted = [...this.series.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [, s] of sorted) {
      let cumulative = 0
      const les = [...this.bounds.map(String), '+Inf']
      les.forEach((le, i) => {
        cumulative += s.counts[i] ?? 0
        lines.push(`${this.name}_bucket${formatLabels({ ...s.labels, le })} ${cumulative}`)
      })
      lines.push(`${this.name}_sum${formatLabels(s.labels)} ${s.sum}`)
      lines.push(`${this.name}_count${formatLabels(s.labels)} ${cumulative}`)
    }
    return lines
  }

  reset(): void {
    this.series.clear()
  }
}

// Label values come from closed enums (route, cold/warm) and `le`: no escaping needed.
function formatLabels(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`)
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

const P = 'narrative_client_'

const histograms = {
  ttfb: new Histogram(
    `${P}nav_ttfb_ms`,
    'Document time to first byte, from navigation start',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  fcp: new Histogram(
    `${P}nav_fcp_ms`,
    'First contentful paint, from navigation start',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  dcl: new Histogram(
    `${P}nav_dom_content_loaded_ms`,
    'DOMContentLoaded end, from navigation start',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  wsConnected: new Histogram(
    `${P}deck_ws_connected_ms`,
    'Deck open: WebSocket connected, from the deck route mount',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  wsSynced: new Histogram(
    `${P}deck_ws_synced_ms`,
    'Deck open: document synced, from the deck route mount',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  pixiReady: new Histogram(
    `${P}deck_pixi_ready_ms`,
    'Deck open: renderer initialised, from the deck route mount',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  firstPaint: new Histogram(
    `${P}deck_first_paint_ms`,
    'Deck open: first canvas frame, from the deck route mount',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  deckLongTasks: new Histogram(
    `${P}deck_long_task_ms`,
    'Deck open: long-task time between the deck route mount and the first paint',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  longTaskCount: new Histogram(
    `${P}session_long_tasks`,
    'Long tasks (> 50 ms) per session',
    CLIENT_METRICS_COUNT_BUCKETS,
  ),
  longTaskTotal: new Histogram(
    `${P}session_long_task_ms`,
    'Long-task time per session',
    CLIENT_METRICS_MS_BUCKETS,
  ),
  longTaskMax: new Histogram(
    `${P}session_longest_task_ms`,
    'The longest task of a session',
    CLIENT_METRICS_INTERACTION_BUCKETS,
  ),
  inp: new Histogram(
    `${P}inp_ms`,
    'Interaction to Next Paint per session (worst, or p98 from 50 interactions)',
    CLIENT_METRICS_INTERACTION_BUCKETS,
  ),
} as const

let reports = new Map<string, number>()

/** Fold one validated report into the histograms. */
export function recordClientMetrics(report: ClientMetricsReport): void {
  const route = { route: report.route }
  reports.set(report.route, (reports.get(report.route) ?? 0) + 1)
  const { nav, deckLoad, longTasks, inp } = report
  if (nav.ttfbMs !== null) histograms.ttfb.observe(nav.ttfbMs, route)
  if (nav.fcpMs !== null) histograms.fcp.observe(nav.fcpMs, route)
  if (nav.domContentLoadedMs !== null) histograms.dcl.observe(nav.domContentLoadedMs, route)
  if (deckLoad !== null) {
    const deck = { ...route, load: deckLoad.cold ? 'cold' : 'warm' }
    if (deckLoad.wsConnectedMs !== null)
      histograms.wsConnected.observe(deckLoad.wsConnectedMs, deck)
    if (deckLoad.wsSyncedMs !== null) histograms.wsSynced.observe(deckLoad.wsSyncedMs, deck)
    if (deckLoad.pixiReadyMs !== null) histograms.pixiReady.observe(deckLoad.pixiReadyMs, deck)
    if (deckLoad.firstPaintMs !== null) histograms.firstPaint.observe(deckLoad.firstPaintMs, deck)
    histograms.deckLongTasks.observe(deckLoad.longTaskMs, deck)
  }
  histograms.longTaskCount.observe(longTasks.count, route)
  histograms.longTaskTotal.observe(longTasks.totalMs, route)
  histograms.longTaskMax.observe(longTasks.maxMs, route)
  if (inp.inpMs !== null) histograms.inp.observe(inp.inpMs, route)
}

/** The client histograms in Prometheus text format (appended to /metrics). */
export function formatClientMetrics(): string[] {
  const lines = [
    `# HELP ${P}reports_total Session reports received from the editor`,
    `# TYPE ${P}reports_total counter`,
    ...[...reports.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([route, n]) => `${P}reports_total{route="${route}"} ${n}`),
  ]
  for (const h of Object.values(histograms)) lines.push(...h.render())
  return lines
}

/** Tests only. */
export function _resetClientMetrics(): void {
  reports = new Map()
  for (const h of Object.values(histograms)) h.reset()
}
