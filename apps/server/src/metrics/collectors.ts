/**
 * apps/server/src/metrics/collectors.ts
 *
 * Minimal in-process metric counters + gauges pro Prometheus text format.
 * Žádný prom-client lib — overkill pro M6 baseline. M29 přidá plný stack.
 *
 * Thread safety: Node.js je single-threaded → atomicita není problém.
 */

import { formatClientMetrics } from './clientMetrics.js'

/**
 * Media reads and deletes that answer an asset the caller may not have with
 * the same 404 as an unknown id (existence is not leaked, performance.md →
 * F6): which route refused, and why. Callers never see the reason; the
 * server keeps it in its log (`mediaRefusal`) and here.
 *   url         GET /api/media/:id/url, media.url
 *   video_info  GET /api/media/:id/video-info, media.status
 *   font_url    GET /api/media/:id/font-url, media.fontUrl
 *   delete      DELETE /api/media/:id, media.delete
 * Reasons: `unknown` (no such asset of that kind), `wrong_kind` (an image
 * read asked of a video or font), `not_shown` (not the named deck's, master's
 * or folder's), `legacy` (a font row from before folder fonts), `forbidden`
 * (the caller may not read it).
 */
export const MEDIA_REFUSAL_ROUTES = ['url', 'video_info', 'font_url', 'delete'] as const
export type MediaRefusalRoute = (typeof MEDIA_REFUSAL_ROUTES)[number]
export const MEDIA_REFUSAL_REASONS = [
  'unknown',
  'wrong_kind',
  'not_shown',
  'legacy',
  'forbidden',
] as const
export type MediaRefusalReason = (typeof MEDIA_REFUSAL_REASONS)[number]

let wsConnections = 0
let updatesIngested = 0
let updatesBytes = 0
const mediaRefusals = new Map<`${MediaRefusalRoute}:${MediaRefusalReason}`, number>()

export const metrics = {
  incConnections(): void {
    wsConnections++
  },

  decConnections(): void {
    wsConnections = Math.max(0, wsConnections - 1)
  },

  recordUpdate(byteLength: number): void {
    updatesIngested++
    updatesBytes += byteLength
  },

  recordMediaRefusal(route: MediaRefusalRoute, reason: MediaRefusalReason): void {
    const key = `${route}:${reason}` as const
    mediaRefusals.set(key, (mediaRefusals.get(key) ?? 0) + 1)
  },

  /** Media refusals so far for one route, by reason (every reason listed). */
  mediaRefusals(route: MediaRefusalRoute): Record<MediaRefusalReason, number> {
    return Object.fromEntries(
      MEDIA_REFUSAL_REASONS.map((reason) => [reason, mediaRefusals.get(`${route}:${reason}`) ?? 0]),
    ) as Record<MediaRefusalReason, number>
  },

  /** Vrátí snapshot aktuálních hodnot. */
  snapshot(): { wsConnections: number; updatesIngested: number; updatesBytes: number } {
    return { wsConnections, updatesIngested, updatesBytes }
  },

  /** Reset — používá se v testech. */
  _reset(): void {
    wsConnections = 0
    updatesIngested = 0
    updatesBytes = 0
    mediaRefusals.clear()
  },
}

export function formatPrometheus(): string {
  return [
    '# HELP narrative_ws_connections Current active Hocuspocus connections',
    '# TYPE narrative_ws_connections gauge',
    `narrative_ws_connections ${wsConnections}`,
    '',
    '# HELP narrative_updates_ingested_total Total Yjs updates received',
    '# TYPE narrative_updates_ingested_total counter',
    `narrative_updates_ingested_total ${updatesIngested}`,
    '',
    '# HELP narrative_updates_bytes_total Total bytes of Yjs updates received',
    '# TYPE narrative_updates_bytes_total counter',
    `narrative_updates_bytes_total ${updatesBytes}`,
    '',
    '# HELP narrative_media_refusals_total Media reads and deletes refused as an unknown asset, by route and reason (callers see 404 for all)',
    '# TYPE narrative_media_refusals_total counter',
    ...MEDIA_REFUSAL_ROUTES.flatMap((route) =>
      MEDIA_REFUSAL_REASONS.map(
        (reason) =>
          `narrative_media_refusals_total{route="${route}",reason="${reason}"} ${mediaRefusals.get(`${route}:${reason}`) ?? 0}`,
      ),
    ),
    '',
    // The editor's session reports (metrics/clientMetrics.ts).
    ...formatClientMetrics(),
    '',
  ].join('\n')
}
