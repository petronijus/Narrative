/**
 * metrics/metricsEndpoint.test.ts
 *
 * Integration test pro /metrics Fastify endpoint.
 * Spouští reálnou Fastify instanci (bez Hocuspocus/DB).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerMetricsEndpoint, metrics } from './index.js'

describe('GET /metrics endpoint', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await registerMetricsEndpoint(app)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    metrics._reset()
  })

  it('vrátí 200 s text/plain content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
  })

  it('vrátí Prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    const body = res.body

    expect(body).toContain('# HELP narrative_ws_connections')
    expect(body).toContain('# TYPE narrative_ws_connections gauge')
    expect(body).toContain('narrative_ws_connections')
  })

  it('reflektuje aktuální hodnoty metrik', async () => {
    metrics.incConnections()
    metrics.incConnections()
    metrics.recordUpdate(2048)

    const res = await app.inject({ method: 'GET', url: '/metrics' })
    const body = res.body

    expect(body).toContain('narrative_ws_connections 2')
    expect(body).toContain('narrative_updates_ingested_total 1')
    expect(body).toContain('narrative_updates_bytes_total 2048')
  })

  it('endpoint je idempotentní — více volání vrátí konzistentní data', async () => {
    metrics.incConnections()

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/metrics' }),
      app.inject({ method: 'GET', url: '/metrics' }),
    ])

    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    // Obě odpovědi by měly mít stejný obsah (stejný snapshot)
    expect(r1.body).toBe(r2.body)
  })
})
