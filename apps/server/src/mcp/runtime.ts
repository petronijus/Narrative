/**
 * mcp/runtime.ts — the MCP server's parts, created once per process
 * (index.ts): the tool catalog and guidance (both generated at start, so a
 * command whose schema cannot become a tool, or a broken playbook, fails the
 * start instead of disappearing), the session registry and the OAuth
 * authorization server.
 *
 * It also wires the revocation paths to the live sessions:
 *   - a revoked OAuth grant closes its sessions (the service's listener);
 *   - the session manager is registered with auth/agentSessions.ts, so the
 *     account kill switch and the revocation of one personal access token
 *     close theirs, without the auth layer importing this module;
 * and runs the OAuth housekeeping hourly (`McpOAuthService.runMaintenance`:
 * expired tokens and requests, stale registered clients, 30-day retention of
 * decided authorizations and revoked grants). It gives the session sweep its
 * `verifyCredential` (the PAT or OAuth grant still live, the user still
 * allowed to sign in), which is how revocations made outside this process
 * reach open sessions, and logs the OAuth service's security events.
 */

import type { FastifyBaseLogger } from 'fastify'
import type { AgentRuntime } from '../agent/runtime.js'
import { credentialKeyForToken, registerAgentSessionRegistry } from '../auth/agentSessions.js'
import type { PatService } from '../auth/personalAccessTokens.js'
import type { McpPublicConfig } from './config.js'
import { Guidance } from './guidance.js'
import { createClientMetadataResolver, type ClientMetadataFetcher } from './oauth/clientMetadata.js'
import { McpOAuthService, SUPPORTED_SCOPES, type McpTokenOwner } from './oauth/service.js'
import type { McpOAuthStore } from './oauth/store.js'
import { confirmationPageUrl } from '../agent/confirmations.js'
import { McpSessionManager } from './sessions.js'
import { ToolCatalog } from './tools.js'

export interface McpRuntime {
  config: McpPublicConfig
  catalog: ToolCatalog
  guidance: Guidance
  sessions: McpSessionManager
  oauth: McpOAuthService
  shutdown(): Promise<void>
}

export interface McpRuntimeOptions {
  agent: Pick<AgentRuntime, 'host' | 'registry' | 'confirmations'>
  config: McpPublicConfig
  oauthStore: McpOAuthStore
  /** The sign-in policy re-applied to every OAuth token's user (see McpOAuthServiceOptions). */
  isOwnerAllowed: (owner: McpTokenOwner) => Promise<boolean>
  /**
   * The personal access token service (the same one the auth plugin uses):
   * the session sweep asks it whether a session's token is still live.
   */
  pats: Pick<PatService, 'isLive'>
  /**
   * Called with a revoked OAuth connection's credential key, after its MCP
   * sessions are closed: what else it opened goes too (upload sessions,
   * index.ts). Resolves to how many were removed.
   */
  onCredentialRevoked?: (credentialKey: string) => Promise<number>
  /** Server version reported in the initialize result. */
  version: string
  log: FastifyBaseLogger
  // Test seams.
  sessionIdleMs?: number
  maxSessionsPerUser?: number
  /** Start the idle-session sweeper and the hourly OAuth maintenance (default true). */
  sweep?: boolean
  now?: () => Date
  /** Fetches Client ID Metadata Documents (default: through the SSRF guard). */
  fetchClientMetadata?: ClientMetadataFetcher
}

/** How often the OAuth housekeeping runs, and how soon after start the first run is. */
export const OAUTH_MAINTENANCE_INTERVAL_MS = 60 * 60_000
export const OAUTH_FIRST_MAINTENANCE_DELAY_MS = 60_000

const OAUTH_CREDENTIAL_PREFIX = credentialKeyForToken('oauth:')
const TOKEN_CREDENTIAL_PREFIX = credentialKeyForToken('')

export function createMcpRuntime(opts: McpRuntimeOptions): McpRuntime {
  const catalog = new ToolCatalog(opts.agent.registry)
  const guidance = new Guidance(opts.agent.registry)
  // Assigned below; the sweep only runs once the runtime exists.
  let oauth!: McpOAuthService
  /**
   * The credential a session was opened with (mcp/auth.ts `credentialKey`)
   * is still good for its user: `token:oauth:<grantId>` an OAuth grant,
   * `token:<patId>` a personal access token, `session:<sub>` BYPASS_AUTH's
   * dev-user (no credential to revoke). Anything else is not ours: dead.
   */
  const verifyCredential = async (credentialKey: string, userId: string): Promise<boolean> => {
    if (credentialKey.startsWith(OAUTH_CREDENTIAL_PREFIX))
      return oauth.isGrantLive(credentialKey.slice(OAUTH_CREDENTIAL_PREFIX.length), userId)
    if (credentialKey.startsWith(TOKEN_CREDENTIAL_PREFIX))
      return opts.pats.isLive(credentialKey.slice(TOKEN_CREDENTIAL_PREFIX.length), userId)
    return credentialKey === `session:${userId}`
  }
  const sessions = new McpSessionManager({
    verifyCredential,
    host: opts.agent.host,
    confirmations: opts.agent.confirmations,
    confirmUrl: (id) => confirmationPageUrl(opts.config.spaOrigin, id),
    catalog,
    guidance,
    version: opts.version,
    log: opts.log,
    ...(opts.sessionIdleMs === undefined ? {} : { idleMs: opts.sessionIdleMs }),
    ...(opts.maxSessionsPerUser === undefined ? {} : { maxPerUser: opts.maxSessionsPerUser }),
    ...(opts.sweep === undefined ? {} : { sweep: opts.sweep }),
    ...(opts.now === undefined ? {} : { now: () => opts.now!().getTime() }),
  })
  const now = opts.now ?? (() => new Date())
  const clientMetadata = createClientMetadataResolver({
    allowedRedirectUris: opts.config.allowedRedirectUris,
    supportedScopes: SUPPORTED_SCOPES,
    now: () => now().getTime(),
    ...(opts.fetchClientMetadata === undefined ? {} : { fetch: opts.fetchClientMetadata }),
    onFetchError: (clientId, err) =>
      opts.log.warn({ err, clientId }, 'fetching an OAuth client metadata document failed'),
  })
  oauth = new McpOAuthService({
    store: opts.oauthStore,
    config: opts.config,
    isOwnerAllowed: opts.isOwnerAllowed,
    clientMetadata,
    now,
    onBackgroundError: (err) => opts.log.error({ err }, 'MCP OAuth background write failed'),
    // A security log line (grep `event`): a replayed refresh token.
    onSecurityEvent: (event) =>
      opts.log.warn(
        event,
        event.revoked
          ? 'MCP OAuth refresh token replayed: grant flagged and revoked'
          : 'MCP OAuth refresh token replayed by its own client: grant flagged',
      ),
  })
  // A revoked connection loses its open MCP sessions at once, not at their
  // next request (which would fail anyway).
  oauth.onGrantRevoked((grantId) => {
    const key = credentialKeyForToken(`oauth:${grantId}`)
    void sessions.closeCredential(key)
    if (opts.onCredentialRevoked !== undefined) {
      opts
        .onCredentialRevoked(key)
        .catch((err: unknown) =>
          opts.log.error(
            { err, grantId },
            'MCP OAuth revocation: removing what the grant opened failed',
          ),
        )
    }
  })
  // The account kill switch and PAT revocation reach the sessions through
  // auth/agentSessions.ts (the auth layer cannot import the MCP server).
  const unregister = registerAgentSessionRegistry({
    closeUser: (userSub, reason) => sessions.closeUser(userSub, reason),
    closeCredential: (key, reason) => sessions.closeCredential(key, reason),
  })

  const maintain = async (): Promise<void> => {
    try {
      const { staleClients, purgedAuthorizations, purgedGrants } = await oauth.runMaintenance()
      if (staleClients > 0)
        opts.log.info({ staleClients }, 'deleted stale OAuth client registrations')
      if (purgedAuthorizations > 0 || purgedGrants > 0)
        opts.log.info(
          { purgedAuthorizations, purgedGrants },
          'OAuth retention: old authorizations and revoked grants deleted',
        )
    } catch (err) {
      opts.log.error({ err }, 'MCP OAuth maintenance failed')
    }
  }
  let maintenance: ReturnType<typeof setInterval> | null = null
  let firstMaintenance: ReturnType<typeof setTimeout> | null = null
  if (opts.sweep !== false) {
    // Once soon after start too: a server redeployed more often than hourly
    // would otherwise never get to it.
    firstMaintenance = setTimeout(() => void maintain(), OAUTH_FIRST_MAINTENANCE_DELAY_MS)
    firstMaintenance.unref?.()
    maintenance = setInterval(() => void maintain(), OAUTH_MAINTENANCE_INTERVAL_MS)
    maintenance.unref?.()
  }

  return {
    config: opts.config,
    catalog,
    guidance,
    sessions,
    oauth,
    async shutdown() {
      if (firstMaintenance !== null) clearTimeout(firstMaintenance)
      if (maintenance !== null) clearInterval(maintenance)
      unregister()
      await sessions.closeAll()
    },
  }
}
