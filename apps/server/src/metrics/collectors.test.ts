/**
 * metrics/collectors.test.ts
 *
 * Unit testy pro Prometheus metric collectors.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  metrics,
  formatPrometheus,
  MEDIA_REFUSAL_REASONS,
  MEDIA_REFUSAL_ROUTES,
} from './collectors.js'

describe('metrics collectors', () => {
  beforeEach(() => {
    metrics._reset()
  })

  it('incConnections zvýší counter', () => {
    metrics.incConnections()
    metrics.incConnections()
    const s = metrics.snapshot()
    expect(s.wsConnections).toBe(2)
  })

  it('decConnections sníží counter, min 0', () => {
    metrics.incConnections()
    metrics.decConnections()
    metrics.decConnections() // Pod nulu nesmí jít
    const s = metrics.snapshot()
    expect(s.wsConnections).toBe(0)
  })

  it('recordUpdate inkrementuje counter i byty', () => {
    metrics.recordUpdate(100)
    metrics.recordUpdate(250)
    const s = metrics.snapshot()
    expect(s.updatesIngested).toBe(2)
    expect(s.updatesBytes).toBe(350)
  })

  it('snapshot vrátí konzistentní kopii', () => {
    metrics.incConnections()
    metrics.recordUpdate(512)

    const s = metrics.snapshot()
    expect(s.wsConnections).toBe(1)
    expect(s.updatesIngested).toBe(1)
    expect(s.updatesBytes).toBe(512)
  })
})

describe('formatPrometheus', () => {
  beforeEach(() => {
    metrics._reset()
  })

  it('vrátí validní Prometheus text format', () => {
    metrics.incConnections()
    metrics.incConnections()
    metrics.recordUpdate(1024)

    const output = formatPrometheus()

    expect(output).toContain('# HELP narrative_ws_connections')
    expect(output).toContain('# TYPE narrative_ws_connections gauge')
    expect(output).toContain('narrative_ws_connections 2')

    expect(output).toContain('# HELP narrative_updates_ingested_total')
    expect(output).toContain('# TYPE narrative_updates_ingested_total counter')
    expect(output).toContain('narrative_updates_ingested_total 1')

    expect(output).toContain('# HELP narrative_updates_bytes_total')
    expect(output).toContain('# TYPE narrative_updates_bytes_total counter')
    expect(output).toContain('narrative_updates_bytes_total 1024')
  })

  it('vrátí nulové hodnoty při resetu', () => {
    const output = formatPrometheus()
    expect(output).toContain('narrative_ws_connections 0')
    expect(output).toContain('narrative_updates_ingested_total 0')
    expect(output).toContain('narrative_updates_bytes_total 0')
  })

  it('výstup má správný MIME type format (text/plain)', () => {
    // Prometheus specifikace: každá metrika má HELP + TYPE + value lines
    const output = formatPrometheus()
    const lines = output.split('\n').filter((l) => l.trim().length > 0)

    const helpLines = lines.filter((l) => l.startsWith('# HELP'))
    const typeLines = lines.filter((l) => l.startsWith('# TYPE'))
    const valueLines = lines.filter((l) => !l.startsWith('#'))

    // The four server metrics (the media refusals one sample per route and
    // reason); the editor's session histograms (clientMetrics.ts) add HELP +
    // TYPE per family and no sample until a report arrives (beyond their
    // families, they are tested in routes/clientMetrics.test.ts).
    const server = (l: string) => !l.includes('narrative_client_')
    expect(helpLines.filter(server).length).toBe(4)
    expect(typeLines.filter(server).length).toBe(4)
    expect(valueLines.filter(server).length).toBe(
      3 + MEDIA_REFUSAL_ROUTES.length * MEDIA_REFUSAL_REASONS.length,
    )
    expect(helpLines.length).toBe(typeLines.length)
  })
})

describe('media refusals', () => {
  beforeEach(() => {
    metrics._reset()
  })

  it('counts each route and reason apart, so the server can tell what callers cannot (all see 404)', () => {
    metrics.recordMediaRefusal('url', 'forbidden')
    metrics.recordMediaRefusal('url', 'forbidden')
    metrics.recordMediaRefusal('url', 'unknown')
    metrics.recordMediaRefusal('delete', 'forbidden')

    expect(metrics.mediaRefusals('url')).toEqual({
      unknown: 1,
      wrong_kind: 0,
      not_shown: 0,
      legacy: 0,
      forbidden: 2,
    })
    expect(metrics.mediaRefusals('delete').forbidden).toBe(1)
    expect(metrics.mediaRefusals('font_url').forbidden).toBe(0)
    const output = formatPrometheus()
    expect(output).toContain('# TYPE narrative_media_refusals_total counter')
    expect(output).toContain('narrative_media_refusals_total{route="url",reason="forbidden"} 2')
    expect(output).toContain('narrative_media_refusals_total{route="url",reason="unknown"} 1')
    expect(output).toContain('narrative_media_refusals_total{route="delete",reason="forbidden"} 1')
    expect(output).toContain('narrative_media_refusals_total{route="video_info",reason="legacy"} 0')

    metrics._reset()
    expect(metrics.mediaRefusals('url').forbidden).toBe(0)
  })
})
