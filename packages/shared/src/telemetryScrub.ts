/**
 * shared/src/telemetryScrub.ts — what an error report may carry, for the
 * server's Sentry (apps/server/src/observability/sentry.ts) and the editor's
 * (apps/web/src/main.tsx) alike.
 *
 * Two layers, because a credential in an error report is a credential handed
 * to a third party:
 *
 *   1. `TELEMETRY_DATA_COLLECTION` — what the SDK collects at all (Sentry's
 *      `dataCollection`, v10+). Since `sendDefaultPii` went away, leaving it
 *      unset collects cookies, headers, request and response bodies, query
 *      parameters, user fields, database and queue payloads and stack-frame
 *      variables. Here: none of those, but a few harmless request headers.
 *      Deck content (bodies, job data) is a user's, not an error report's.
 *   2. `scrubTelemetryPayload` — on every event, span and breadcrumb that
 *      still leaves (`beforeSend`, `beforeSendSpan`, `beforeBreadcrumb`):
 *      - the values of `Authorization`, `Cookie`, `Set-Cookie` and
 *        `Proxy-Authorization` (any casing, wherever a `headers` object
 *        appears) and of `request.cookies` become `[Filtered]`;
 *      - any Narrative credential (credentialPatterns.ts: access tokens,
 *        OAuth tokens / codes / secrets, upload sessions, render tokens),
 *        every `share_token=` value and the `narrative_session=` cookie value
 *        inside ANY string — a message, a URL, a span attribute — are masked,
 *        the prefix kept so a report shows which kind leaked;
 *      - PKCE verifiers (`verifier`, `code_verifier`: the desktop sign-in
 *        redeem and the MCP OAuth token request), as object keys or as
 *        `key=value` in a form body, are replaced too: they carry no prefix.
 *    Relying on the SDK's own defaults alone would make this depend on
 *    whatever an SDK version decides.
 */

import { maskCredentials, maskShareTokens } from './credentialPatterns.js'

export const FILTERED = '[Filtered]'

/**
 * Sentry's `dataCollection`, as plain data (shared has no Sentry dependency;
 * each SDK checks the shape where it is passed).
 */
export const TELEMETRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: {
      allow: ['accept', 'accept-language', 'content-length', 'content-type', 'user-agent'],
    },
    response: false,
  },
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

/** Header names whose values are credentials (compared lower-cased). */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization'])

/** The session cookie's value anywhere in a string (the server's auth/session.ts). */
const SESSION_COOKIE_RE = /(narrative_session=)[^;\s"',&]+/g

const MAX_DEPTH = 32

/** Body keys that hold a PKCE verifier (no prefix to recognise it by). */
const PKCE_VERIFIER_KEYS = new Set(['verifier', 'code_verifier'])
/** The same in a form-encoded string (a request body kept as text). */
const PKCE_VERIFIER_FIELD_RE = /\b((?:code_)?verifier=)[^&#\s"'<>]*/g

/** `value` with every credential, share token and session cookie masked. */
export function scrubString(value: string): string {
  return maskShareTokens(maskCredentials(value, FILTERED), FILTERED)
    .replace(SESSION_COOKIE_RE, `$1${FILTERED}`)
    .replace(PKCE_VERIFIER_FIELD_RE, `$1${FILTERED}`)
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
      (parentKey === 'request' && lower === 'cookies') ||
      // A parsed query (`query_string` as an object or pairs) names it as a key.
      lower === 'share_token' ||
      PKCE_VERIFIER_KEYS.has(lower)
    ) {
      out[key] = FILTERED
      continue
    }
    out[key] = scrub(child, depth + 1, seen, lower)
  }
  return out
}

/**
 * A scrubbed copy of a Sentry event, span or breadcrumb (see the header for
 * exactly what is removed). Never throws; the input is not modified.
 */
export function scrubTelemetryPayload<T>(payload: T): T {
  return scrub(payload, 0, new WeakSet(), '') as T
}
