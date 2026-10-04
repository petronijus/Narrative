/**
 * auth/userAccess.test.ts — the core of the revokeUserAccess ops script:
 * resolve the user by email or sub, revoke sessions and agent credentials
 * (or count them on a dry run), and report whether the user could sign in
 * again.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../hocuspocus/connections.js', () => ({ closeUserConnections: vi.fn(() => 0) }))

import { resolveUser, revokeUserAccess } from './userAccess.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

const allowlist = { allowedEmails: ['petr@example.com'], allowedDomain: undefined }
const row = (sub: string, email: string) => ({
  sub,
  email,
  emailVerified: true,
  name: null,
  pictureUrl: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
})

describe('resolveUser', () => {
  it('looks an email up in the directory, and refuses an unknown one', async () => {
    await expect(
      resolveUser(scriptedDb({ selects: [[row('u1', 'a@example.org')]] }).db, 'a@example.org'),
    ).resolves.toEqual({ sub: 'u1', email: 'a@example.org', emailVerified: true })
    await expect(
      resolveUser(scriptedDb({ selects: [[]] }).db, 'nobody@example.org'),
    ).resolves.toBeNull()
  })

  it('accepts a sub even without a directory entry', async () => {
    await expect(resolveUser(scriptedDb({ selects: [[]] }).db, ' 1066 ')).resolves.toEqual({
      sub: '1066',
      email: null,
      emailVerified: false,
    })
    await expect(resolveUser(scriptedDb().db, '   ')).resolves.toBeNull()
  })
})

describe('revokeUserAccess', () => {
  it('revokes sessions, tokens and connected apps, and reports a user nothing admits any more', async () => {
    const db = scriptedDb({
      updates: [[{ idHash: 's' }], [{ id: 't1' }, { id: 't2' }], [{ id: 'g1' }]],
      deletes: [[{ id: 'us1' }]],
      // The sign-in check: no deck or folder invite, no deck permission, no shared folder.
      selects: [[], [], [], []],
    })
    const report = await revokeUserAccess(
      db.db,
      { sub: 'u1', email: 'gone@example.org', emailVerified: true },
      { allowlist },
    )
    expect(report).toMatchObject({
      revoked: { sessions: 1, personalAccessTokens: 2, mcpOAuthGrants: 1, uploadSessions: 1 },
      dryRun: false,
      stillAllowedBy: null,
    })
    expect(db.writes.map((w) => w.table)).toEqual([
      'sessions',
      'personal_access_tokens',
      'mcp_oauth_grants',
      'mcp_oauth_tokens',
      // Unexchanged OAuth authorizations expire with the grants.
      'mcp_oauth_authorizations',
      'upload_sessions',
    ])
  })

  it('warns when the env allowlist would let the user straight back in', async () => {
    const db = scriptedDb({ updates: [[], [], []] })
    const report = await revokeUserAccess(
      db.db,
      { sub: 'u1', email: 'petr@example.com', emailVerified: true },
      { allowlist },
    )
    expect(report.stillAllowedBy).toBe('env')
  })

  it('only counts on a dry run', async () => {
    // Selects: live sessions, live tokens, live OAuth grants, upload
    // sessions, then the sign-in check (no deck or folder invite, one deck
    // permission).
    const db = scriptedDb({
      selects: [[{ n: 3 }], [{ n: 1 }], [{ n: 2 }], [{ n: 4 }], [], [], [{ deckId: 'd' }]],
    })
    const report = await revokeUserAccess(
      db.db,
      { sub: 'u1', email: 'x@example.org', emailVerified: true },
      { allowlist, dryRun: true },
    )
    expect(report.revoked).toEqual({
      sessions: 3,
      personalAccessTokens: 1,
      mcpOAuthGrants: 2,
      uploadSessions: 4,
    })
    expect(report.dryRun).toBe(true)
    expect(report.stillAllowedBy).toBe('permission')
    expect(db.writes).toEqual([])
  })
})
