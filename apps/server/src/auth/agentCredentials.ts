/**
 * auth/agentCredentials.ts
 *
 * The single place that kills every credential an agent can act with for one
 * user. Account-level kill switches — `revokeAllSessionsForUser`
 * (auth/session.ts), and through it the `revokeUserAccess` ops script — call
 * this, so no agent credential can outlive the user's sessions.
 *
 * It revokes:
 *   - every personal access token of the user;
 *   - every MCP OAuth grant of the user (claude.ai connectors and other OAuth
 *     MCP clients), and with it every access and refresh token of the grant;
 * and then ends the user's live MCP sessions in this process
 * (auth/agentSessions.ts), so an open session does not keep working until
 * its next request fails.
 *
 * Any NEW kind of agent credential MUST be revoked here as well: add its bulk
 * revoke to `revokeAllAgentCredentialsForUser` and its count to
 * `RevokedAgentCredentials`, and extend auth/agentCredentials.test.ts.
 */

import type { Database } from '../db/client.js'
import { revokeAllMcpGrantsForUser } from '../mcp/oauth/store.js'
import { closeAgentSessionsForUser } from './agentSessions.js'
import { revokeAllPersonalAccessTokensForUser } from './personalAccessTokens.js'

/** How many credentials of each kind were revoked. */
export interface RevokedAgentCredentials {
  personalAccessTokens: number
  /** MCP OAuth grants ("connected apps"); each takes its tokens with it. */
  mcpOAuthGrants: number
}

export async function revokeAllAgentCredentialsForUser(
  db: Database,
  userSub: string,
): Promise<RevokedAgentCredentials> {
  const now = new Date()
  const personalAccessTokens = await revokeAllPersonalAccessTokensForUser(db, userSub, now)
  const mcpOAuthGrants = await revokeAllMcpGrantsForUser(db, userSub, now)
  // After the database revocations: a client that reconnects in between is
  // refused, because its credential is already dead.
  await closeAgentSessionsForUser(userSub)
  return { personalAccessTokens, mcpOAuthGrants }
}
