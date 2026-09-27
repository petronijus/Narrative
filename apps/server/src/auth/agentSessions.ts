/**
 * auth/agentSessions.ts
 *
 * Live agent sessions that authenticated with a credential — today the MCP
 * sessions (mcp/sessions.ts), which are bound to one user and one credential
 * at `initialize` and then live in process memory for up to 30 minutes of
 * inactivity. Revoking a credential makes their NEXT request fail, but an
 * open session (and its server→client stream) would stay up until then; the
 * kill switches below end them at once instead.
 *
 * The auth layer must not import the MCP server (the MCP server imports the
 * auth layer), so the MCP runtime registers itself here through a small
 * interface when it starts (mcp/runtime.ts), and the revocation paths call
 * these functions:
 *   - `closeAgentSessionsForUser`   the account kill switch
 *                                   (auth/agentCredentials.ts);
 *   - `closeAgentSessionsForCredential(credentialKeyForToken(id))`
 *                                   one personal access token revoked
 *                                   (routes/accessTokens.ts). OAuth grants
 *                                   close their own sessions through the
 *                                   OAuth service's revocation listener.
 * With no registry registered (HTTP-only tests, the ops script in its own
 * process) they close nothing and return 0.
 *
 * Single process, like the rate limiter and the Hocuspocus connection
 * registry: a second API instance would need a fan-out.
 */

/** What a live-session owner (the MCP runtime) offers the revocation paths. */
export interface AgentSessionRegistry {
  /** End every session of a user. Resolves to how many were ended. */
  closeUser(userSub: string, reason: string): Promise<number>
  /** End every session that authenticated with `credentialKey`. */
  closeCredential(credentialKey: string, reason: string): Promise<number>
}

const registries = new Set<AgentSessionRegistry>()

/**
 * The credential key of a token-authenticated request, as sessions record it:
 * `token:<tokenId>`, where `tokenId` is `RequestAuth.tokenId` — a personal
 * access token's id, or `oauth:<grantId>` for an MCP OAuth access token.
 */
export function credentialKeyForToken(tokenId: string): string {
  return `token:${tokenId}`
}

/**
 * Register a live-session owner; returns the function that unregisters it.
 * Production has one (the MCP runtime); tests may run several side by side.
 */
export function registerAgentSessionRegistry(r: AgentSessionRegistry): () => void {
  registries.add(r)
  return () => {
    registries.delete(r)
  }
}

async function closeEverywhere(
  close: (r: AgentSessionRegistry) => Promise<number>,
): Promise<number> {
  let closed = 0
  for (const r of [...registries]) closed += await close(r)
  return closed
}

/** End every live agent session of a user. Resolves to how many were ended. */
export function closeAgentSessionsForUser(userSub: string): Promise<number> {
  return closeEverywhere((r) => r.closeUser(userSub, 'account access revoked'))
}

/** End every live agent session that authenticated with `credentialKey`. */
export function closeAgentSessionsForCredential(credentialKey: string): Promise<number> {
  return closeEverywhere((r) => r.closeCredential(credentialKey, 'credential revoked'))
}
