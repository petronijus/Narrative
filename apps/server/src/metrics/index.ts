/**
 * apps/server/src/metrics/index.ts
 *
 * Registruje /metrics endpoint na Fastify instanci.
 *
 * Vrací Prometheus text format (version 0.0.4).
 * TODO(M29): přidat Bearer token auth — endpoint prozatím bez autorizace.
 *            Dokud není veřejný internet nebo multi-tenant, přijatelné.
 *
 * Použití:
 *   import { registerMetricsEndpoint } from './metrics/index.js'
 *   await registerMetricsEndpoint(app)
 */

import type { FastifyInstance } from 'fastify'
import { formatPrometheus } from './collectors.js'

export { metrics, formatPrometheus } from './collectors.js'

export async function registerMetricsEndpoint(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_request, reply) => {
    // TODO(M29): přidat auth check (Bearer token nebo IP allowlist)
    await reply.type('text/plain; version=0.0.4; charset=utf-8').send(formatPrometheus())
  })
}
