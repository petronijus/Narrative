/**
 * apps/server/src/metrics/collectors.ts
 *
 * Minimal in-process metric counters + gauges pro Prometheus text format.
 * Žádný prom-client lib — overkill pro M6 baseline. M29 přidá plný stack.
 *
 * Thread safety: Node.js je single-threaded → atomicita není problém.
 */

import { formatClientMetrics } from './clientMetrics.js'

let wsConnections = 0
let updatesIngested = 0
let updatesBytes = 0

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

  /** Vrátí snapshot aktuálních hodnot. */
  snapshot(): { wsConnections: number; updatesIngested: number; updatesBytes: number } {
    return { wsConnections, updatesIngested, updatesBytes }
  },

  /** Reset — používá se v testech. */
  _reset(): void {
    wsConnections = 0
    updatesIngested = 0
    updatesBytes = 0
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
    // The editor's session reports (metrics/clientMetrics.ts).
    ...formatClientMetrics(),
    '',
  ].join('\n')
}
