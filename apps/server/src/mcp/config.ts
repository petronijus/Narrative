/**
 * mcp/config.ts — public URLs of the MCP server and its OAuth authorization
 * server.
 *
 * The API cannot derive its public URL from requests: Caddy strips one
 * `/api` (handle_path) and rewrites `Host` to the upstream, so the server
 * sees `/mcp` on `server:3001` while clients call
 * `https://<domain>/api/mcp`. The base is therefore configured:
 *
 *   PUBLIC_API_URL   public base of the API, no trailing slash
 *                    default dev:  http://localhost:<API_PORT>
 *                    default prod: <SPA origin>/api (= https://<DOMAIN>/api)
 *
 * Derived (RFC 9728 / RFC 8414 / MCP authorization spec 2025-11-25):
 *   resource              <base>/mcp — the canonical MCP server URI; every
 *                         OAuth token is bound to it (audience)
 *   resourceMetadataUrl   <base>/.well-known/oauth-protected-resource/mcp —
 *                         sent in WWW-Authenticate; reachable through the
 *                         /api prefix, so it works without extra proxy routes
 *   issuer                <base> — the authorization server. Its RFC 8414
 *                         metadata lives at
 *                         https://<domain>/.well-known/oauth-authorization-server/api
 *                         (path insertion at the host root), which Caddy
 *                         routes to the API unstripped (infra/caddy/Caddyfile:
 *                         `/.well-known/oauth-*`). The same route serves the
 *                         RFC 9728 root form of the resource metadata,
 *                         https://<domain>/.well-known/oauth-protected-resource/api/mcp.
 *
 *   MCP_OAUTH_REDIRECT_URIS  comma-separated extra redirect URIs clients may
 *                         use besides the built-in claude.ai and Claude Code
 *                         callbacks: https URLs (matched exactly) or http
 *                         loopback URLs (localhost / 127.0.0.1, any port).
 *
 *   MCP_OAUTH_CIMD_HOSTS  comma-separated hosts whose Client ID Metadata
 *                         Documents Narrative accepts (default `claude.ai`:
 *                         Claude Code's document lives there). A metadata
 *                         client_id on any other host is refused before
 *                         anything is fetched. `none` accepts no document at
 *                         all (and stops advertising the capability).
 *   MCP_OAUTH_DCR_ENABLED `true` turns dynamic client registration (RFC 7591)
 *                         on; default off. Off, the registration endpoint is
 *                         not advertised and POST /oauth/register answers 404.
 *                         Claude Code and claude.ai use metadata documents
 *                         whenever the server advertises them, so DCR is only
 *                         needed for other clients.
 */

export interface McpPublicConfig {
  /** Public base URL of the API (no trailing slash). */
  apiBaseUrl: string
  /** The canonical MCP resource URI (`<base>/mcp`). */
  resource: string
  resourceMetadataUrl: string
  issuer: string
  /** Where the SPA lives (sign-in pages, account settings). */
  spaOrigin: string
  /**
   * The redirect URIs a client may use (mcp/oauth/redirects.ts): the claude.ai
   * callback, Claude Code's loopback callbacks (any port), then
   * MCP_OAUTH_REDIRECT_URIS.
   */
  allowedRedirectUris: readonly string[]
  /**
   * Hosts (lower case, `host[:port]`) whose Client ID Metadata Documents are
   * accepted (MCP_OAUTH_CIMD_HOSTS). Empty: metadata documents are refused.
   */
  cimdHosts: readonly string[]
  /** Dynamic client registration is on (MCP_OAUTH_DCR_ENABLED). */
  dcrEnabled: boolean
}

/** The default Client ID Metadata Document host allowlist (Claude Code's document). */
export const DEFAULT_CIMD_HOSTS: readonly string[] = ['claude.ai']

/** Why an MCP_OAUTH_CIMD_HOSTS entry is unusable, or null. */
function cimdHostProblem(host: string): string | null {
  let u: URL
  try {
    u = new URL(`https://${host}`)
  } catch {
    return 'is not a host name'
  }
  if (u.host !== host || u.pathname !== '/' || u.search !== '' || u.hash !== '')
    return 'must be a bare lower-case host (optionally with a port), without scheme or path'
  return null
}

/**
 * The one OAuth callback of every hosted Claude app (claude.ai web, Desktop,
 * mobile, Cowork), per Anthropic's connector documentation.
 */
export const CLAUDE_AI_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'

/**
 * Claude Code's RFC 8252 loopback callbacks. It binds an ephemeral port, so
 * these match on any port (redirects.ts); its Client ID Metadata Document
 * (https://claude.ai/oauth/claude-code-client-metadata) declares exactly these.
 */
export const CLAUDE_CODE_REDIRECT_URIS = [
  'http://localhost/callback',
  'http://127.0.0.1/callback',
] as const

/** The built-in allowlist, before MCP_OAUTH_REDIRECT_URIS. */
export const DEFAULT_REDIRECT_URIS: readonly string[] = [
  CLAUDE_AI_REDIRECT_URI,
  ...CLAUDE_CODE_REDIRECT_URIS,
]

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Why an MCP_OAUTH_REDIRECT_URIS entry is unusable, or null. */
function extraRedirectProblem(uri: string): string | null {
  let u: URL
  try {
    u = new URL(uri)
  } catch {
    return 'is not an absolute URL'
  }
  if (u.hash !== '' || uri.includes('#')) return 'must not carry a fragment'
  if (u.username !== '' || u.password !== '') return 'must not carry credentials'
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
    return null
  return 'must be an https URL, or an http URL on localhost / 127.0.0.1'
}

export function buildMcpPublicConfig(opts: {
  apiBaseUrl: string
  spaOrigin: string
  extraRedirectUris?: readonly string[]
  /** Default DEFAULT_CIMD_HOSTS. */
  cimdHosts?: readonly string[]
  /** Default false. */
  dcrEnabled?: boolean
}): McpPublicConfig {
  const base = trimSlash(opts.apiBaseUrl)
  const parsed = new URL(base)
  if (parsed.search !== '' || parsed.hash !== '')
    throw new Error(`PUBLIC_API_URL must not carry a query or fragment: ${opts.apiBaseUrl}`)
  for (const uri of opts.extraRedirectUris ?? []) {
    const problem = extraRedirectProblem(uri)
    if (problem !== null) throw new Error(`MCP_OAUTH_REDIRECT_URIS entry ${uri} ${problem}`)
  }
  const cimdHosts = opts.cimdHosts ?? DEFAULT_CIMD_HOSTS
  for (const host of cimdHosts) {
    const problem = cimdHostProblem(host)
    if (problem !== null) throw new Error(`MCP_OAUTH_CIMD_HOSTS entry ${host} ${problem}`)
  }
  return {
    apiBaseUrl: base,
    resource: `${base}/mcp`,
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
    issuer: base,
    spaOrigin: trimSlash(opts.spaOrigin),
    allowedRedirectUris: [
      ...new Set([...DEFAULT_REDIRECT_URIS, ...(opts.extraRedirectUris ?? [])]),
    ],
    cimdHosts: [...new Set(cimdHosts)],
    dcrEnabled: opts.dcrEnabled ?? false,
  }
}

/**
 * MCP_OAUTH_CIMD_HOSTS: unset or blank → the default (`claude.ai`), `none` →
 * no host, otherwise the comma-separated hosts (lower-cased).
 */
export function cimdHostsFromEnv(raw: string | undefined): readonly string[] {
  const value = raw?.trim() ?? ''
  if (value === '') return DEFAULT_CIMD_HOSTS
  if (value.toLowerCase() === 'none') return []
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** MCP_OAUTH_DCR_ENABLED: `true` / `false` (or unset / blank = false); anything else fails the start. */
export function dcrEnabledFromEnv(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? ''
  if (value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`MCP_OAUTH_DCR_ENABLED must be true or false, got ${JSON.stringify(raw)}`)
}

/** Read the configuration from the environment (index.ts). */
export function mcpPublicConfigFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: { apiPort: number; isProd: boolean; spaOrigin: string },
): McpPublicConfig {
  // Production serves the API under the SPA's origin (Caddy: /api/*), so the
  // SPA origin is the default base there — it is always configured
  // (SPA_ORIGIN, else https://DOMAIN in index.ts), while DOMAIN itself is not
  // passed to the server container.
  const apiBaseUrl =
    env['PUBLIC_API_URL']?.trim() ||
    (defaults.isProd
      ? `${trimSlash(defaults.spaOrigin)}/api`
      : `http://localhost:${defaults.apiPort}`)
  const extra = (env['MCP_OAUTH_REDIRECT_URIS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return buildMcpPublicConfig({
    apiBaseUrl,
    spaOrigin: defaults.spaOrigin,
    extraRedirectUris: extra,
    cimdHosts: cimdHostsFromEnv(env['MCP_OAUTH_CIMD_HOSTS']),
    dcrEnabled: dcrEnabledFromEnv(env['MCP_OAUTH_DCR_ENABLED']),
  })
}

/** The path part of a URL without the leading slash (`https://x/api/mcp` → `api/mcp`). */
export function pathWithoutLeadingSlash(url: string): string {
  return new URL(url).pathname.replace(/^\/+/, '').replace(/\/+$/, '')
}
