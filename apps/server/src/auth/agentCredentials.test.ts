/**
 * auth/agentCredentials.test.ts — account-level kill switches reach agent
 * credentials: revoking a user's sessions also revokes every personal access
 * token and every MCP OAuth grant (with its tokens) of theirs, expires their
 * not-yet-exchanged OAuth authorizations (so an approved code cannot mint a
 * new grant after the kill switch), ends their
 * live MCP sessions, and closes their live WebSocket connections. Any future
 * kind of agent credential must be added here too (auth/agentCredentials.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../hocuspocus/connections.js', () => ({ closeUserConnections: vi.fn(() => 0) }))

import { revokeAllAgentCredentialsForUser } from './agentCredentials.js'
import { registerAgentSessionRegistry, type AgentSessionRegistry } from './agentSessions.js'
import { revokeAllSessionsForUser } from './session.js'
import { closeUserConnections } from '../hocuspocus/connections.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

let registry: { closeUser: ReturnType<typeof vi.fn>; closeCredential: ReturnType<typeof vi.fn> }
let unregister: () => void

beforeEach(() => {
  vi.clearAllMocks()
  registry = { closeUser: vi.fn(async () => 2), closeCredential: vi.fn(async () => 0) }
  unregister = registerAgentSessionRegistry(registry as unknown as AgentSessionRegistry)
})

afterEach(() => unregister())

describe('revokeAllAgentCredentialsForUser', () => {
  it('revokes the user’s personal access tokens and MCP OAuth grants, then ends their MCP sessions', async () => {
    const db = scriptedDb({
      updates: [
        [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        [{ id: 'g1' }, { id: 'g2' }],
      ],
    })
    await expect(revokeAllAgentCredentialsForUser(db.db, 'user-1')).resolves.toEqual({
      personalAccessTokens: 3,
      mcpOAuthGrants: 2,
    })
    // The grants' tokens are revoked with them, and unexchanged authorizations expire.
    expect(db.writes.map((w) => w.table)).toEqual([
      'personal_access_tokens',
      'mcp_oauth_grants',
      'mcp_oauth_tokens',
      'mcp_oauth_authorizations',
    ])
    expect(db.writes[3]!.values).toEqual({
      expiresAt: expect.any(Date),
      codeExpiresAt: expect.any(Date),
    })
    expect(registry.closeUser).toHaveBeenCalledWith('user-1', expect.any(String))
    expect(registry.closeCredential).not.toHaveBeenCalled()
  })

  it('skips the token update when the user has no live grant, and still expires their authorizations and ends their sessions', async () => {
    const db = scriptedDb({ updates: [[], []] })
    await expect(revokeAllAgentCredentialsForUser(db.db, 'user-1')).resolves.toEqual({
      personalAccessTokens: 0,
      mcpOAuthGrants: 0,
    })
    expect(db.writes.map((w) => w.table)).toEqual([
      'personal_access_tokens',
      'mcp_oauth_grants',
      'mcp_oauth_authorizations',
    ])
    expect(registry.closeUser).toHaveBeenCalledWith('user-1', expect.any(String))
  })

  it('works without a live-session registry (the ops script runs in its own process)', async () => {
    unregister()
    const db = scriptedDb({ updates: [[{ id: 't1' }], []] })
    await expect(revokeAllAgentCredentialsForUser(db.db, 'user-1')).resolves.toEqual({
      personalAccessTokens: 1,
      mcpOAuthGrants: 0,
    })
    expect(registry.closeUser).not.toHaveBeenCalled()
  })
})

describe('revokeAllSessionsForUser', () => {
  it('revokes sessions AND agent credentials, then closes live connections', async () => {
    const db = scriptedDb({
      updates: [[{ idHash: 'a' }, { idHash: 'b' }], [{ id: 't1' }], [{ id: 'g1' }]],
    })
    await expect(revokeAllSessionsForUser(db.db, 'user-1')).resolves.toEqual({
      sessions: 2,
      personalAccessTokens: 1,
      mcpOAuthGrants: 1,
    })
    expect(db.writes.map((w) => w.table)).toEqual([
      'sessions',
      'personal_access_tokens',
      'mcp_oauth_grants',
      'mcp_oauth_tokens',
      'mcp_oauth_authorizations',
    ])
    expect(closeUserConnections).toHaveBeenCalledWith('user-1')
    expect(registry.closeUser).toHaveBeenCalledWith('user-1', expect.any(String))
  })
})
