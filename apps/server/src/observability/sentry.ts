/**
 * apps/server/src/observability/sentry.ts
 *
 * Server-side Sentry, gated on SENTRY_DSN: without it nothing is initialised
 * and nothing is sent.
 *
 * Fastify integration: `setupFastifyErrorHandler` captures unhandled route
 * errors.
 *
 * Scrubbing (security review L7): every event, transaction and breadcrumb
 * passes through `scrubSentryPayload` before it leaves the process:
 *   - the values of `Authorization`, `Cookie` and `Set-Cookie` headers (any
 *     casing, wherever a `headers` object appears) and of `request.cookies`
 *     are replaced with `[Filtered]`;
 *   - any Narrative credential — personal access token (`nrt_…`), MCP OAuth
 *     access/refresh token, authorization code or client secret (`nmo_…`,
 *     `nmr_…`, `nmc_…`, `nms_…`) — and any `narrative_session=` cookie
 *     value inside ANY string — an error message, a URL, a stack frame
 *     variable — is masked.
 * A credential in an error report is a credential handed to a third party;
 * relying on the SDK's default PII settings alone would make that depend on
 * SDK version defaults.
 *
 * M29: add @sentry/profiling-node once the full observability stack lands.
 */

import type { FastifyInstance } from 'fastify'

let _initialized = false

export const FILTERED = '[Filtered]'

/** Header names whose values are credentials (compared lower-cased). */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])

/**
 * Any Narrative credential anywhere in a string: personal access tokens
 * (auth/personalAccessTokens.ts) and the MCP OAuth access tokens, refresh
 * tokens, authorization codes and client secrets (mcp/oauth). The prefix is
 * kept so a report still shows WHICH kind of credential leaked.
 */
const CREDENTIAL_RE = /\b(nrt|nmo|nmr|nmc|nms)_[A-Za-z0-9_-]+/g
/** The session cookie's value anywhere in a string (auth/session.ts). */
const SESSION_COOKIE_RE = /(narrative_session=)[^;\s"',&]+/g

const MAX_DEPTH = 32

export function scrubString(value: string): string {
  return value.replace(CREDENTIAL_RE, `$1_${FILTERED}`).replace(SESSION_COOKIE_RE, `$1${FILTERED}`)
}

function scrub(value: unknown, depth: number, seen: WeakSet<object>, parentKey: string): unknown {
  if (typeof value === 'string') return scrubString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value) || depth > MAX_DEPTH) return FILTERED
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1, seen, parentKey))
  }
  // Leave non-plain objects (Dates, Buffers, class instances) alone apart
  // from plain-object recursion: Sentry payloads are JSON-shaped.
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) return value

  const isHeaders = parentKey === 'headers'
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (
      (isHeaders && SECRET_HEADERS.has(lower)) ||
      (parentKey === 'request' && lower === 'cookies')
    ) {
      out[key] = FILTERED
      continue
    }
    out[key] = scrub(child, depth + 1, seen, lower)
  }
  return out
}

/**
 * Return a scrubbed copy of a Sentry event, transaction or breadcrumb (see
 * the header comment for exactly what is removed). Never throws; the input
 * is not modified.
 */
export function scrubSentryPayload<T>(payload: T): T {
  return scrub(payload, 0, new WeakSet(), '') as T
}

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
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryPayload(event),
    beforeSendTransaction: (event) => scrubSentryPayload(event),
    beforeBreadcrumb: (breadcrumb) => scrubSentryPayload(breadcrumb),
    // TODO(M29): add the profiling-node integration.
  })

  setupFastifyErrorHandler(app)
  _initialized = true
  console.log('[sentry] Initialized (server)')
}

export function isSentryInitialized(): boolean {
  return _initialized
}
