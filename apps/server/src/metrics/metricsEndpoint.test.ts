/**
 * metrics/metricsEndpoint.test.ts
 *
 * Integration test pro /metrics Fastify endpoint.
 * Spouští reálnou Fastify instanci (bez Hocuspocus/DB).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import {
  registerMetricsEndpoint,
  metrics,
  metricsRegistrationDecision,
  METRICS_TOKEN_MIN_LENGTH,
} from './index.js'

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

describe('GET /metrics — Bearer token auth', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await registerMetricsEndpoint(app, { token: 'secret-token' })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('401 bez Authorization headeru', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(401)
  })

  it('401 se špatným tokenem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('200 se správným Bearer tokenem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
  })
})

describe('GET /metrics — loopback fallback when no token', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await registerMetricsEndpoint(app, { token: '' })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('200 pro loopback klienta (inject → 127.0.0.1)', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
  })

  it('403 pro non-loopback klienta', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.0.0.5',
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('metricsRegistrationDecision — prod must require a token', () => {
  it('REFUSES registration in production when METRICS_TOKEN is unset', () => {
    const d = metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: undefined })
    expect(d.register).toBe(false)
    if (!d.register) expect(d.reason).toMatch(/METRICS_TOKEN/)
  })

  it('REFUSES registration in production when METRICS_TOKEN is empty/whitespace', () => {
    expect(metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: '' }).register).toBe(
      false,
    )
    expect(
      metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: '   ' }).register,
    ).toBe(false)
  })

  it('ALLOWS registration in production when METRICS_TOKEN is a real token', () => {
    expect(
      metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: 'a'.repeat(64) }).register,
    ).toBe(true)
    // Exactly the minimum length, surrounding whitespace trimmed.
    expect(
      metricsRegistrationDecision({
        nodeEnv: 'production',
        metricsToken: ` ${'0123456789abcdef'.repeat(2)} `,
      }).register,
    ).toBe(true)
  })

  it('REFUSES TO BOOT in production on a token shorter than the minimum', () => {
    expect(METRICS_TOKEN_MIN_LENGTH).toBe(32)
    expect(() =>
      metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: 'secret' }),
    ).toThrow(/at least 32 characters/)
    expect(() =>
      metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: 'a'.repeat(31) }),
    ).toThrow(/METRICS_TOKEN/)
  })

  it('REFUSES TO BOOT in production on the CHANGE_ME placeholder, whatever its length', () => {
    for (const placeholder of [
      'CHANGE_ME_64_HEX_CHARS',
      `CHANGE_ME_${'0'.repeat(64)}`,
      `${'f'.repeat(40)}changeme`,
      `${'f'.repeat(40)}Change-Me`,
    ]) {
      expect(() =>
        metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: placeholder }),
      ).toThrow(/placeholder/)
    }
  })

  it('accepts any token outside production (tests and dev use short ones)', () => {
    expect(
      metricsRegistrationDecision({ nodeEnv: 'development', metricsToken: 'secret' }).register,
    ).toBe(true)
    expect(
      metricsRegistrationDecision({ nodeEnv: 'test', metricsToken: 'CHANGE_ME' }).register,
    ).toBe(true)
  })

  it('ALLOWS registration in dev even without a token (loopback fallback covers it)', () => {
    expect(
      metricsRegistrationDecision({ nodeEnv: 'development', metricsToken: undefined }).register,
    ).toBe(true)
  })

  it('ALLOWS registration when NODE_ENV is unset (treated as dev)', () => {
    expect(
      metricsRegistrationDecision({ nodeEnv: undefined, metricsToken: undefined }).register,
    ).toBe(true)
  })
})

describe('GET /metrics — not registered without a token in prod (404)', () => {
  it('returns 404 when the route was skipped (prod + no token)', async () => {
    // Simulate the index.ts decision: in prod with no token we skip
    // registerMetricsEndpoint entirely, so the route does not exist.
    const decision = metricsRegistrationDecision({ nodeEnv: 'production', metricsToken: '' })
    const app = Fastify({ logger: false })
    if (decision.register) await registerMetricsEndpoint(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(404)
    await app.close()
  })
})
