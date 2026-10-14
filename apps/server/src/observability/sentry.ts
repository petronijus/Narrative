/**
 * apps/server/src/observability/sentry.ts
 *
 * Server-side Sentry, gated on SENTRY_DSN: without it nothing is initialised
 * and nothing is sent.
 *
 * What a report may carry is shared with the editor
 * (@narrative/shared telemetryScrub.ts): `dataCollection` keeps the SDK from
 * collecting cookies, bodies, query strings, user fields, database and queue
 * payloads and stack-frame variables, and every event, span and breadcrumb
 * passes `scrubTelemetryPayload` before it leaves the process.
 *
 * Fastify errors: the SDK's default `fastifyIntegration` captures them from
 * Fastify's diagnostics channel (5xx by default), whenever Sentry is
 * initialised relative to the app; `setupFastifyErrorHandler` is a no-op
 * since v10. Spans stream (`traceLifecycle: 'stream'`, the v11 default), so
 * span scrubbing is `beforeSendSpan` — `beforeSendTransaction` no longer runs.
 *
 * M29: add @sentry/profiling-node once the full observability stack lands.
 */

import { TELEMETRY_DATA_COLLECTION, scrubTelemetryPayload } from '@narrative/shared'

let _initialized = false

export async function initSentry(): Promise<void> {
  const dsn = process.env['SENTRY_DSN']
  if (!dsn) {
    // No DSN = silent. Dev-friendly.
    return
  }

  const { init } = await import('@sentry/node')

  init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    tracesSampleRate: 0.1,
    dataCollection: TELEMETRY_DATA_COLLECTION,
    beforeSend: (event) => scrubTelemetryPayload(event),
    beforeSendSpan: (span) => scrubTelemetryPayload(span),
    beforeBreadcrumb: (breadcrumb) => scrubTelemetryPayload(breadcrumb),
    // TODO(M29): add the profiling-node integration.
  })

  _initialized = true
  console.log('[sentry] Initialized (server)')
}

export function isSentryInitialized(): boolean {
  return _initialized
}
