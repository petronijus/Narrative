/**
 * mcp/oauth/redirects.ts — which redirect URIs an OAuth client may use, and
 * when an authorization request's redirect URI matches one it declared.
 *
 * The allowlist (McpPublicConfig.allowedRedirectUris, built in config.ts) is
 * exactly what Anthropic's connector documentation names, plus the operator's
 * extras:
 *   - `https://claude.ai/api/mcp/auth_callback` — the one callback of every
 *     hosted Claude app (claude.ai web, Desktop, mobile, Cowork);
 *   - `http://localhost/callback` and `http://127.0.0.1/callback` — Claude
 *     Code's RFC 8252 loopback redirects, on an ephemeral port;
 *   - MCP_OAUTH_REDIRECT_URIS — further https callbacks, or loopback URIs for
 *     other local clients.
 * A client (registered, or described by a Client ID Metadata Document) may
 * only declare redirect URIs on that list, and at /authorize the requested
 * URI must match both one the client declared and the list — so a client can
 * only ever send an authorization code to claude.ai, to the user's own
 * machine, or to a callback the operator added.
 *
 * Matching (`sameRedirect`):
 *   - https: exact string equality;
 *   - http loopback (`localhost`, `127.0.0.1`): scheme, host, path and query
 *     must be equal, the PORT IS IGNORED (OAuth 2.1 §2.3.1 / RFC 8252 §7.3:
 *     a native app binds an ephemeral port per attempt, and Claude Code's
 *     metadata document declares the loopback URIs without one);
 *   - never a fragment or userinfo, on either side. `[::1]` and every other
 *     host or scheme are refused.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

const MAX_REDIRECT_URI_LENGTH = 512

function parse(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

function clean(u: URL, raw: string): boolean {
  return u.hash === '' && !raw.includes('#') && u.username === '' && u.password === ''
}

/** An http URI on a loopback host (`localhost`, `127.0.0.1`), without fragment or userinfo. */
export function isLoopbackRedirect(uri: string): boolean {
  const u = parse(uri)
  return u !== null && u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname) && clean(u, uri)
}

/** Do two redirect URIs denote the same callback (loopback: any port)? */
export function sameRedirect(a: string, b: string): boolean {
  const ua = parse(a)
  const ub = parse(b)
  if (ua === null || ub === null || !clean(ua, a) || !clean(ub, b)) return false
  if (isLoopbackRedirect(a) && isLoopbackRedirect(b)) {
    return ua.hostname === ub.hostname && ua.pathname === ub.pathname && ua.search === ub.search
  }
  return ua.protocol === 'https:' && a === b
}

/** Is `uri` on the allowlist? */
export function redirectUriAllowed(uri: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => sameRedirect(uri, entry))
}

/** Null when a client may declare `uri`; otherwise why not (for the error message). */
export function redirectUriRegistrationProblem(
  uri: unknown,
  allowed: readonly string[],
): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH)
    return `must be a URL of at most ${MAX_REDIRECT_URI_LENGTH} characters`
  const u = parse(uri)
  if (u === null) return 'is not a valid absolute URL'
  if (u.hash !== '' || uri.includes('#')) return 'must not contain a fragment'
  if (u.username !== '' || u.password !== '') return 'must not contain credentials'
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return 'must use https (or http on a loopback address)'
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname))
    return 'http is allowed only for the loopback addresses localhost and 127.0.0.1'
  return redirectUriAllowed(uri, allowed)
    ? null
    : `is not an allowed callback (Narrative accepts ${allowed.join(', ')}; loopback URIs on any port)`
}

/** Does the requested redirect URI match one the client declared? */
export function redirectUriMatches(requested: string, declared: readonly string[]): boolean {
  return declared.some((uri) => sameRedirect(requested, uri))
}

/** True when every declared redirect URI is a loopback one (the consent page warns). */
export function onlyLoopbackRedirects(declared: readonly string[]): boolean {
  return declared.length > 0 && declared.every(isLoopbackRedirect)
}
