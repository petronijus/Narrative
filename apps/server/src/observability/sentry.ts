/**
 * apps/server/src/observability/sentry.ts
 *
 * Sentry init pro server — dev-gated: init se volá jen pokud je SENTRY_DSN set.
 * Bez DSN = tiché, žádné errors, žádná inicializace.
 *
 * Fastify integration: setupFastifyErrorHandler zachytí unhandled route errors.
 *
 * M29: Přidat @sentry/profiling-node až bude full observability stack.
 */

import type { FastifyInstance } from 'fastify'

let _initialized = false

export async function initSentry(app: FastifyInstance): Promise<void> {
  const dsn = process.env['SENTRY_DSN']
  if (!dsn) {
    // No DSN = silent. Dev-friendly.
    return
  }

  const { init, setupFastifyErrorHandler } = await import('@sentry/node')

  init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    tracesSampleRate: 0.1,
    // TODO(M29): přidat profiling-node integration
  })

  setupFastifyErrorHandler(app)
  _initialized = true
  console.log('[sentry] Initialized (server)')
}

export function isSentryInitialized(): boolean {
  return _initialized
}
