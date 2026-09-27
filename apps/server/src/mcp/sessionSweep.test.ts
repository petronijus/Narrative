/**
 * mcp/sessionSweep.test.ts — the minute sweep of MCP sessions re-verifies
 * every live session's credential and its user's sign-in policy, so a
 * revocation made OUTSIDE this process (the `revokeUserAccess` ops script, a
 * database edit, an allowlist change) ends open sessions — and their SSE
 * streams — within a minute. The revocations here are made straight in the
 * stores, bypassing the in-process kill switches, exactly like the ops
 * script does from its own process.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpWorld, type McpWorld } from '../test-support/mcpWorld.js'
import { hashPersonalAccessToken } from '../auth/personalAccessTokens.js'
import { hashSecret } from './oauth/service.js'

let w: McpWorld

beforeEach(async () => {
  w = await createMcpWorld()
})

afterEach(async () => {
  await w.destroy()
})

/** A PAT row as the database holds it, found by its raw token. */
function patRow(raw: string) {
  const row = w.patStore.rows.find((r) => r.tokenHash === hashPersonalAccessToken(raw))
  if (row === undefined) throw new Error('no such token')
  return row
}

/** Seed an OAuth grant with a live access token for `user` straight into the store. */
async function oauthToken(user: string): Promise<{ raw: string; grantId: string }> {
  const grantId = `grant-${randomBytes(4).toString('hex')}`
  const now = new Date()
  await w.oauthStore.insertGrant({
    id: grantId,
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    redirectUri: 'http://127.0.0.1:1/callback',
    userSub: user,
    scopes: ['mcp'],
    grantTypes: ['authorization_code', 'refresh_token'],
    resource: `${w.baseUrl}/mcp`,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
    flaggedAt: null,
    flagReason: null,
  })
  const raw = `nmo_${randomBytes(32).toString('base64url')}`
  await w.oauthStore.insertToken({
    tokenHash: hashSecret(raw),
    grantId,
    kind: 'access',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    usedAt: null,
    usedByFingerprint: null,
    revokedAt: null,
  })
  return { raw, grantId }
}

describe('the session sweep re-verifies credentials', () => {
  it('keeps sessions whose credential is still good', async () => {
    await w.client(await w.token('user-1'))
    await w.client((await oauthToken('user-1')).raw)
    await w.mcp.sessions.sweep()
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(2)
  })

  it('ends the sessions of a personal access token revoked or expired out of process, and only those', async () => {
    const revoked = await w.token('user-1')
    const expired = await w.token('user-1')
    const kept = await w.token('user-1')
    for (const t of [revoked, expired, kept]) await w.client(t)
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(3)

    patRow(revoked).revokedAt = new Date()
    patRow(expired).expiresAt = new Date(Date.now() - 1000)
    await w.mcp.sessions.sweep()
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(1)
  })

  it('ends the sessions of an OAuth grant revoked out of process', async () => {
    const { raw, grantId } = await oauthToken('user-1')
    await w.client(raw)
    w.oauthStore.grants.get(grantId)!.revokedAt = new Date()
    await w.mcp.sessions.sweep()
    expect(w.mcp.sessions.size).toBe(0)
  })

  it('ends the sessions of a user the sign-in policy no longer admits', async () => {
    await w.client((await oauthToken('user-1')).raw)
    await w.client((await oauthToken('user-2')).raw)
    w.refusedOwners.add('user-1')
    await w.mcp.sessions.sweep()
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(0)
    expect(w.mcp.sessions.sessionsOf('user-2')).toHaveLength(1)
  })

  it('checks each credential once, and keeps its sessions when the check itself fails', async () => {
    const token = await w.token('user-1')
    await w.client(token)
    await w.client(token)
    const spy = vi.spyOn(w.pats, 'isLive').mockRejectedValueOnce(new Error('database down'))
    await w.mcp.sessions.sweep()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(2)
    // The next sweep, with the database back, keeps them too (the token is live).
    await w.mcp.sessions.sweep()
    expect(w.mcp.sessions.sessionsOf('user-1')).toHaveLength(2)
  })
})
