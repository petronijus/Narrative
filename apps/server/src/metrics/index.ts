/**
 * apps/server/src/metrics/index.ts
 *
 * Registruje /metrics endpoint na Fastify instanci.
 *
 * Vrací Prometheus text format (version 0.0.4).
 *
 * Auth: scraping is gated so the endpoint isn't publicly readable.
 *   - If `METRICS_TOKEN` (env) is set, an `Authorization: Bearer <token>`
 *     header is required (constant-time compared).
 *   - If no token is configured, only loopback clients (127.0.0.1 / ::1)
 *     are allowed — so an unconfigured prod deployment behind a proxy is
 *     refused (403) rather than exposed. Set METRICS_TOKEN to scrape from
 *     another host.
 *
 * Použití:
 *   import { registerMetricsEndpoint } from './metrics/index.js'
 *   await registerMetricsEndpoint(app)
 */

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { formatPrometheus } from './collectors.js'

export { metrics, formatPrometheus } from './collectors.js'

export interface MetricsEndpointOptions {
  /** Bearer token required to scrape. Defaults to `process.env.METRICS_TOKEN`. */
  token?: string
  /**
   * When no token is configured, restrict scraping to loopback clients.
   * Defaults to true (secure-by-default). Set false only for an isolated
   * trusted network where IP-level access control lives elsewhere.
   */
  loopbackOnlyWhenUnset?: boolean
}

/**
 * Decides whether the /metrics route may be registered.
 *
 * /metrics leaks connection counts / doc sizes, so in production it MUST be
 * gated by a token. If NODE_ENV=production and no METRICS_TOKEN is configured,
 * we refuse to register the route at all (rather than exposing it or
 * boot-failing): the server keeps running, /metrics is simply unreachable
 * until a token is set. In non-prod the loopback fallback inside the endpoint
 * keeps local scraping working, so registration is always allowed.
 *
 * Returns `{ register: false, reason }` to skip registration, else
 * `{ register: true }`.
 */
export function metricsRegistrationDecision(opts: {
  nodeEnv: string | undefined
  metricsToken: string | undefined
}): { register: true } | { register: false; reason: string } {
  const isProd = opts.nodeEnv === 'production'
  const token = (opts.metricsToken ?? '').trim()
  if (isProd && token === '') {
    return {
      register: false,
      reason:
        'METRICS_TOKEN is unset in production — /metrics endpoint NOT registered. ' +
        'Set METRICS_TOKEN to expose Prometheus metrics.',
    }
  }
  return { register: true }
}

/** Length-safe constant-time string compare (timingSafeEqual throws on length mismatch). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.ip
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

export async function registerMetricsEndpoint(
  app: FastifyInstance,
  options: MetricsEndpointOptions = {},
): Promise<void> {
  const token = (options.token ?? process.env['METRICS_TOKEN'] ?? '').trim()
  const loopbackOnly = options.loopbackOnlyWhenUnset ?? true

  app.get('/metrics', async (request, reply) => {
    if (token !== '') {
      const header = request.headers['authorization'] ?? ''
      if (!safeEqual(header, `Bearer ${token}`)) {
        return reply.code(401).type('text/plain; charset=utf-8').send('unauthorized\n')
      }
    } else if (loopbackOnly && !isLoopback(request)) {
      return reply.code(403).type('text/plain; charset=utf-8').send('forbidden\n')
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(formatPrometheus())
  })
}
