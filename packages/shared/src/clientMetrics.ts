/**
 * clientMetrics.ts — the editor's session report (performance plan G4 / S5).
 *
 * One report per sampled page session, sent when the page is first hidden
 * (apps/web/src/observability/sessionMetrics.ts) to `POST /client-metrics`
 * (apps/server/src/metrics/clientMetrics.ts), which folds it into the
 * Prometheus histograms of `/metrics`.
 *
 * Privacy: a report carries durations and counts only — no deck, user, URL,
 * content or device identifier. The route is a coarse kind of page, never a
 * path. Every number is bounded here, so a forged report can skew a
 * histogram but never grow the server's memory.
 */

import { z } from 'zod'

/** The kind of page a session landed on (never a path: no ids). */
export const CLIENT_METRICS_ROUTES = ['editor', 'present', 'home', 'other'] as const
export type ClientMetricsRoute = (typeof CLIENT_METRICS_ROUTES)[number]

/** Longest duration a report may carry (10 min); anything longer is not a load. */
export const CLIENT_METRICS_MAX_MS = 600_000

const ms = z.number().int().min(0).max(CLIENT_METRICS_MAX_MS)
const optionalMs = ms.nullable()
const count = z.number().int().min(0).max(100_000)

export const clientMetricsReportSchema = z
  .object({
    /** Schema version: a client of another build sends what it knows. */
    v: z.literal(1),
    /**
     * A random id per page session (crypto.randomUUID), so the server counts
     * one report per session even when one is sent twice; never stored or
     * logged.
     */
    id: z.uuid(),
    route: z.enum(CLIENT_METRICS_ROUTES),
    /** Navigation timing of the document, ms from navigation start. */
    nav: z
      .object({
        ttfbMs: optionalMs,
        fcpMs: optionalMs,
        domContentLoadedMs: optionalMs,
      })
      .strict(),
    /**
     * The boot waterfall of the last deck the page opened
     * (apps/web/src/state/loadTimings.ts), ms from the deck route's mount;
     * null when the session opened no deck. `cold` = the first deck of the
     * document (chunks, fonts and the WebSocket all new).
     */
    deckLoad: z
      .object({
        cold: z.boolean(),
        wsConnectedMs: optionalMs,
        wsSyncedMs: optionalMs,
        pixiReadyMs: optionalMs,
        firstPaintMs: optionalMs,
        /** Long-task time between the deck route's mount and its first paint. */
        longTaskMs: ms,
      })
      .strict()
      .nullable(),
    /** Long tasks (> 50 ms) over the whole session until the report. */
    longTasks: z.object({ count, totalMs: ms, maxMs: ms }).strict(),
    /**
     * Interaction to Next Paint, estimated as web-vitals does: the worst
     * interaction, or the 98th percentile once there are 50 or more.
     */
    inp: z.object({ interactions: count, inpMs: optionalMs }).strict(),
  })
  .strict()

export type ClientMetricsReport = z.infer<typeof clientMetricsReportSchema>

/** Upper bounds (ms) of the duration histograms; `+Inf` is implied. */
export const CLIENT_METRICS_MS_BUCKETS: readonly number[] = [
  50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, 15_000, 30_000, 60_000,
]

/** Upper bounds (ms) of the INP and longest-task histograms. */
export const CLIENT_METRICS_INTERACTION_BUCKETS: readonly number[] = [
  16, 50, 100, 200, 300, 500, 1000, 2000, 5000,
]

/** Upper bounds of the long-task count histogram. */
export const CLIENT_METRICS_COUNT_BUCKETS: readonly number[] = [0, 1, 2, 5, 10, 20, 50, 100, 500]
