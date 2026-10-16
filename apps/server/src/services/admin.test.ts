/**
 * services/admin.test.ts — instance admins (docs/adr/0014) on the scripted
 * database: only an admin may use the service, the allowed list is
 * case-insensitive and idempotent, and the admin role keeps its guards
 * (never your own). The SQL itself runs against
 * Postgres in services/admin.integration.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { createAdminService, requireAllowableEmail } from './admin.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import type { ServiceDeps } from './deps.js'
import { quietLog } from '../test-support/agentWorld.js'

const T = new Date('2026-10-16T08:00:00Z')

function service(script: Parameters<typeof scriptedDb>[0]) {
  const db = scriptedDb(script)
  return {
    db,
    service: createAdminService({ db: db.db, log: quietLog } as ServiceDeps, {
      allowlist: { allowedEmails: ['petr@example.com'] },
    }),
  }
}

const user = (over: Record<string, unknown> = {}) => ({
  sub: 'u2',
  email: 'jana@example.com',
  name: 'Jana',
  pictureUrl: null,
  emailVerified: true,
  isAdmin: false,
  firstSeenAt: T,
  lastSeenAt: T,
  ...over,
})

describe('requireAllowableEmail', () => {
  it('lower-cases and trims, and refuses what is not an address', () => {
    expect(requireAllowableEmail('  Jana@Example.COM ')).toBe('jana@example.com')
    expect(() => requireAllowableEmail('jana')).toThrow(/email address/)
    expect(() => requireAllowableEmail(`${'a'.repeat(320)}@x.cz`)).toThrow(/email address/)
  })
})

describe('AdminService', () => {
  it('refuses everyone who is not an admin (403), before reading anything else', async () => {
    const { service: s, db } = service({ selects: [[{ isAdmin: false }]] })
    await expect(s.listUsers({ userId: 'u' })).rejects.toMatchObject({ status: 403 })
    expect(db.writes).toEqual([])
    await expect(
      service({ selects: [[]] }).service.allowEmail({ userId: 'ghost', email: 'a@b.cz' }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('lists the people who signed in', async () => {
    const { service: s } = service({ selects: [[{ isAdmin: true }], [user()]] })
    await expect(s.listUsers({ userId: 'admin' })).resolves.toEqual([
      {
        userId: 'u2',
        email: 'jana@example.com',
        name: 'Jana',
        isAdmin: false,
        firstSeenAt: T.toISOString(),
        lastSeenAt: T.toISOString(),
      },
    ])
  })

  it('allows an address in lower case and returns the entry', async () => {
    const entry = {
      email: 'new@example.com',
      addedAt: T,
      addedBy: 'a@example.com',
      signedIn: false,
    }
    // Admin check, the entry; then nobody signed in with it yet — the
    // welcome email's own reads are unscripted and fail quietly.
    const { service: s, db } = service({ selects: [[{ isAdmin: true }], [entry], []] })
    await expect(s.allowEmail({ userId: 'admin', email: 'New@Example.com' })).resolves.toEqual({
      ...entry,
      addedAt: T.toISOString(),
    })
    expect(db.writes).toEqual([
      {
        kind: 'insert',
        table: 'allowed_emails',
        values: { email: 'new@example.com', addedBySub: 'admin' },
      },
    ])
  })

  it('removes an address, and says 404 when it is not on the list', async () => {
    // Nobody with that address has signed in: nothing to sign out.
    const ok = service({
      selects: [[{ isAdmin: true }], []],
      deletes: [[{ email: 'x@example.com' }]],
    })
    await expect(
      ok.service.removeAllowedEmail({ userId: 'admin', email: 'X@example.com' }),
    ).resolves.toEqual({ signedOut: false })
    const missing = service({ selects: [[{ isAdmin: true }]], deletes: [[]] })
    await expect(
      missing.service.removeAllowedEmail({ userId: 'admin', email: 'x@example.com' }),
    ).rejects.toMatchObject({ status: 404 })
  })

  describe('setAdmin', () => {
    it('never changes your own role', async () => {
      const { service: s } = service({})
      await expect(
        s.setAdmin({ userId: 'admin', targetUserId: 'admin', isAdmin: false }),
      ).rejects.toMatchObject({ status: 409 })
    })

    it('refuses a caller who is not an admin, inside the transaction', async () => {
      const { service: s } = service({ selects: [[{ sub: 'other' }]] })
      await expect(
        s.setAdmin({ userId: 'u', targetUserId: 'u2', isAdmin: true }),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('needs a user who has signed in', async () => {
      const { service: s } = service({ selects: [[{ sub: 'admin' }], []] })
      await expect(
        s.setAdmin({ userId: 'admin', targetUserId: 'u2', isAdmin: true }),
      ).rejects.toMatchObject({ status: 404 })
    })

    it('promotes only a person whose Google email is verified', async () => {
      const { service: s, db } = service({
        selects: [[{ sub: 'admin' }], [user({ emailVerified: false })]],
      })
      await expect(
        s.setAdmin({ userId: 'admin', targetUserId: 'u2', isAdmin: true }),
      ).rejects.toMatchObject({ status: 409 })
      expect(db.writes).toEqual([])
    })

    it('promotes a user', async () => {
      const { service: s, db } = service({
        selects: [[{ sub: 'admin' }], [user()]],
        updates: [[user({ isAdmin: true })]],
      })
      await expect(
        s.setAdmin({ userId: 'admin', targetUserId: 'u2', isAdmin: true }),
      ).resolves.toMatchObject({ userId: 'u2', isAdmin: true })
      expect(db.writes).toEqual([{ kind: 'update', table: 'users', values: { isAdmin: true } }])
    })

    it('demotes another admin', async () => {
      const { service: s } = service({
        selects: [[{ sub: 'admin' }, { sub: 'u2' }], [user({ isAdmin: true })]],
        updates: [[user({ isAdmin: false })]],
      })
      await expect(
        s.setAdmin({ userId: 'admin', targetUserId: 'u2', isAdmin: false }),
      ).resolves.toMatchObject({ isAdmin: false })
    })
  })
})
