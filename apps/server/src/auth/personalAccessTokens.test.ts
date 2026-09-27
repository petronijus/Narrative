/**
 * auth/personalAccessTokens.test.ts
 *
 * The personal access token service against an in-memory store with the
 * database's semantics: the raw token exists once and is never stored,
 * verification accepts only live well-formed tokens whose owner is still
 * allowed to sign in, every token expires (at most 365 days), the
 * active-token cap, and `last_used_at` written at most once a minute.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./signInPolicy.js', () => ({ isAllowedToSignIn: vi.fn() }))

import { createHash } from 'node:crypto'
import {
  createPatService,
  hashPersonalAccessToken,
  MAX_ACTIVE_PATS_PER_USER,
  PAT_EXPIRY_DAY_CHOICES,
  PAT_LAST_USED_WRITE_INTERVAL_MS,
  PatError,
  createPatOwnerPolicy,
  parseCreatePatInput,
  refuseAllPatOwners,
  revokeAllPersonalAccessTokensForUser,
  type CreatePatInput,
  type PatOwner,
  type PatService,
} from './personalAccessTokens.js'
import { isAllowedToSignIn } from './signInPolicy.js'
import {
  allowAllPatOwners,
  createMemoryPatStore,
  type MemoryPatStore,
} from '../test-support/memoryPatStore.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import type { Database } from '../db/client.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-09-26T10:00:00Z')

const input = (over: Partial<CreatePatInput> = {}): CreatePatInput => ({
  name: 'MacBook Claude Code',
  scopes: ['mcp'],
  expiresInDays: 365,
  ...over,
})

/** Let fire-and-forget writes settle. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('personal access tokens', () => {
  let store: MemoryPatStore
  let clock: Date
  let pats: PatService

  beforeEach(() => {
    store = createMemoryPatStore()
    clock = new Date(T0)
    pats = createPatService(store, { now: () => clock, isOwnerAllowed: allowAllPatOwners })
  })

  describe('create', () => {
    it('returns the raw token once and stores only its SHA-256 and a short prefix', async () => {
      const { token, summary } = await pats.create('user-1', input())

      expect(token).toMatch(/^nrt_[A-Za-z0-9_-]{43}$/)
      expect(store.rows).toHaveLength(1)
      const row = store.rows[0]!
      expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(row.prefix).toBe(token.slice(0, 10))
      // The secret appears in no stored column.
      const secret = token.slice(4)
      for (const value of Object.values(row)) {
        expect(JSON.stringify(value ?? null)).not.toContain(secret)
      }
      // The summary carries no secret material either.
      expect(JSON.stringify(summary)).not.toContain(secret)
      expect(JSON.stringify(summary)).not.toContain(row.tokenHash)
      expect(summary).toMatchObject({
        name: 'MacBook Claude Code',
        scopes: ['mcp'],
        expired: false,
      })
    })

    it('mints a different token every time', async () => {
      const a = await pats.create('user-1', input())
      const b = await pats.create('user-1', input())
      expect(a.token).not.toBe(b.token)
      expect(store.rows[0]!.tokenHash).not.toBe(store.rows[1]!.tokenHash)
    })

    it('sets expiry from expiresInDays; every token expires within 365 days', async () => {
      for (const days of PAT_EXPIRY_DAY_CHOICES) {
        const { summary } = await pats.create('user-1', input({ expiresInDays: days }))
        expect(summary.expiresAt).toBe(new Date(T0.getTime() + days * DAY).toISOString())
      }
      expect(Math.max(...PAT_EXPIRY_DAY_CHOICES)).toBe(365)
      expect(store.rows.every((r) => r.expiresAt.getTime() <= T0.getTime() + 365 * DAY)).toBe(true)
    })

    it(`caps a user at ${MAX_ACTIVE_PATS_PER_USER} active tokens; revoked and expired ones do not count`, async () => {
      for (let i = 0; i < MAX_ACTIVE_PATS_PER_USER; i++) await pats.create('user-1', input())
      await expect(pats.create('user-1', input())).rejects.toMatchObject({
        code: 'token_limit_reached',
      })
      // Another user is unaffected.
      await expect(pats.create('user-2', input())).resolves.toBeDefined()

      // Revoking one frees a slot.
      await pats.revoke('user-1', store.rows[0]!.id)
      await expect(pats.create('user-1', input())).resolves.toBeDefined()
      await expect(pats.create('user-1', input())).rejects.toBeInstanceOf(PatError)

      // So does expiry.
      const expiring = store.rows.find((r) => r.userSub === 'user-1' && r.revokedAt === null)!
      expiring.expiresAt = new Date(clock.getTime() - 1)
      await expect(pats.create('user-1', input())).resolves.toBeDefined()
    })
  })

  describe('verify', () => {
    it('accepts a valid token and resolves its user, owner directory entry and scopes', async () => {
      store.owners.set('user-1', { email: 'petr@example.com', name: 'Petr' })
      const { token, summary } = await pats.create('user-1', input({ scopes: ['mcp', 'api'] }))

      await expect(pats.verify(token)).resolves.toEqual({
        tokenId: summary.id,
        userSub: 'user-1',
        email: 'petr@example.com',
        name: 'Petr',
        scopes: ['mcp', 'api'],
      })
    })

    it('rejects a revoked token', async () => {
      const { token, summary } = await pats.create('user-1', input())
      expect(await pats.revoke('user-1', summary.id)).toBe(true)
      await expect(pats.verify(token)).resolves.toBeNull()
    })

    it('rejects an expired token, at the exact expiry instant too', async () => {
      const { token } = await pats.create('user-1', input({ expiresInDays: 30 }))
      clock = new Date(T0.getTime() + 30 * DAY - 1)
      await expect(pats.verify(token)).resolves.not.toBeNull()
      clock = new Date(T0.getTime() + 30 * DAY)
      await expect(pats.verify(token)).resolves.toBeNull()
    })

    it('rejects a well-formed token that was never issued', async () => {
      await pats.create('user-1', input())
      const forged = `nrt_${'A'.repeat(43)}`
      await expect(pats.verify(forged)).resolves.toBeNull()
    })

    it('rejects a token with one character changed', async () => {
      const { token } = await pats.create('user-1', input())
      const last = token.at(-1) === 'A' ? 'B' : 'A'
      await expect(pats.verify(token.slice(0, -1) + last)).resolves.toBeNull()
    })

    it('rejects malformed values without touching the store', async () => {
      const before = store.calls.findByHash
      for (const bad of [
        '',
        'nrt_',
        'nrt_short',
        `nrt_${'A'.repeat(44)}`,
        `NRT_${'A'.repeat(43)}`,
        `nrt_${'A'.repeat(42)}=`,
        'Bearer nrt_x',
        'cookie',
      ]) {
        await expect(pats.verify(bad)).resolves.toBeNull()
      }
      expect(store.calls.findByHash).toBe(before)
    })

    it('drops scopes it does not know, and rejects a token left with none', async () => {
      const { token } = await pats.create('user-1', input({ scopes: ['api'] }))
      store.rows[0]!.scopes = ['api', 'admin']
      await expect(pats.verify(token)).resolves.toMatchObject({ scopes: ['api'] })
      store.rows[0]!.scopes = ['admin']
      await expect(pats.verify(token)).resolves.toBeNull()
    })

    it('verifies by hash: the stored hash is what identifies the token', async () => {
      const { token } = await pats.create('user-1', input())
      expect(store.rows[0]!.tokenHash).toBe(hashPersonalAccessToken(token))
    })
  })

  describe('last_used_at', () => {
    it('is written on first use, then at most once per interval', async () => {
      const { token } = await pats.create('user-1', input())
      const row = store.rows[0]!
      expect(row.lastUsedAt).toBeNull()

      await pats.verify(token)
      await flush()
      expect(store.calls.touchLastUsed).toBe(1)
      expect(row.lastUsedAt).toEqual(T0)

      // A burst within the interval writes nothing more.
      for (let i = 0; i < 10; i++) {
        clock = new Date(T0.getTime() + i * 1000)
        await pats.verify(token)
      }
      await flush()
      expect(store.calls.touchLastUsed).toBe(1)

      // Past the interval: one more write.
      clock = new Date(T0.getTime() + PAT_LAST_USED_WRITE_INTERVAL_MS)
      await pats.verify(token)
      await flush()
      expect(store.calls.touchLastUsed).toBe(2)
      expect(row.lastUsedAt).toEqual(clock)
    })

    it('lets exactly one of concurrent first uses write', async () => {
      const { token } = await pats.create('user-1', input())
      await Promise.all(Array.from({ length: 20 }, () => pats.verify(token)))
      await flush()
      expect(store.calls.touchLastUsed).toBe(1)
    })

    it('honours a recent last_used_at already in the database (another process wrote it)', async () => {
      const { token } = await pats.create('user-1', input())
      store.rows[0]!.lastUsedAt = new Date(T0.getTime() - 10_000)
      await pats.verify(token)
      await flush()
      expect(store.calls.touchLastUsed).toBe(0)
    })

    it('never makes authentication wait for, or fail on, the write', async () => {
      const failing = createMemoryPatStore()
      const errors: unknown[] = []
      failing.touchLastUsed = () => Promise.reject(new Error('db down'))
      const svc = createPatService(failing, {
        now: () => clock,
        isOwnerAllowed: allowAllPatOwners,
        onBackgroundError: (e) => errors.push(e),
      })
      const { token } = await svc.create('user-1', input())
      await expect(svc.verify(token)).resolves.not.toBeNull()
      await flush()
      expect(errors).toHaveLength(1)
    })
  })

  describe('list and revoke', () => {
    it('lists the user’s own non-revoked tokens, newest first, marking expired ones', async () => {
      const a = await pats.create('user-1', input({ name: 'a', expiresInDays: 30 }))
      clock = new Date(T0.getTime() + 1000)
      const b = await pats.create('user-1', input({ name: 'b' }))
      const c = await pats.create('user-1', input({ name: 'c' }))
      await pats.create('user-2', input({ name: 'other' }))
      await pats.revoke('user-1', c.summary.id)

      clock = new Date(T0.getTime() + 31 * DAY)
      const list = await pats.list('user-1')
      expect(list.map((t) => t.name)).toEqual(['b', 'a'])
      expect(list.find((t) => t.id === a.summary.id)?.expired).toBe(true)
      expect(list.find((t) => t.id === b.summary.id)?.expired).toBe(false)
    })

    it('revokes only the caller’s own token', async () => {
      const { token, summary } = await pats.create('user-1', input())
      expect(await pats.revoke('user-2', summary.id)).toBe(false)
      await expect(pats.verify(token)).resolves.not.toBeNull()
      expect(await pats.revoke('user-1', summary.id)).toBe(true)
      // Revoking twice reports "no such live token".
      expect(await pats.revoke('user-1', summary.id)).toBe(false)
    })
  })

  describe('isLive (the MCP session sweep)', () => {
    it('is true only for the owner’s own unrevoked, unexpired token', async () => {
      const { summary } = await pats.create('user-1', input({ expiresInDays: 30 }))
      expect(await pats.isLive(summary.id, 'user-1')).toBe(true)
      expect(await pats.isLive(summary.id, 'user-2')).toBe(false)
      expect(await pats.isLive('no-such-token', 'user-1')).toBe(false)
      clock = new Date(T0.getTime() + 31 * DAY)
      expect(await pats.isLive(summary.id, 'user-1')).toBe(false)
      clock = new Date(T0)
      await pats.revoke('user-1', summary.id)
      expect(await pats.isLive(summary.id, 'user-1')).toBe(false)
    })
  })
})

describe('parseCreatePatInput', () => {
  it('accepts a valid body, trimming the name and ordering scopes canonically', () => {
    expect(
      parseCreatePatInput({ name: '  Laptop  ', scopes: ['api', 'mcp'], expiresInDays: 90 }),
    ).toEqual({ name: 'Laptop', scopes: ['mcp', 'api'], expiresInDays: 90 })
    expect(
      parseCreatePatInput({ name: 'x', scopes: ['api'], expiresInDays: 365 }).expiresInDays,
    ).toBe(365)
  })

  it.each([
    [null, 'invalid_body'],
    [[], 'invalid_body'],
    [{ scopes: ['mcp'] }, 'invalid_name'],
    [{ name: '   ', scopes: ['mcp'] }, 'invalid_name'],
    [{ name: 'x'.repeat(81), scopes: ['mcp'] }, 'invalid_name'],
    [{ name: 'x' }, 'invalid_scopes'],
    [{ name: 'x', scopes: [] }, 'invalid_scopes'],
    [{ name: 'x', scopes: ['admin'] }, 'invalid_scopes'],
    [{ name: 'x', scopes: ['mcp', 'mcp'] }, 'invalid_scopes'],
    [{ name: 'x', scopes: 'mcp' }, 'invalid_scopes'],
    [{ name: 'x', scopes: ['mcp'] }, 'invalid_expiry'],
    [{ name: 'x', scopes: ['mcp'], expiresInDays: null }, 'invalid_expiry'],
    [{ name: 'x', scopes: ['mcp'], expiresInDays: 730 }, 'invalid_expiry'],
    [{ name: 'x', scopes: ['mcp'], expiresInDays: 7 }, 'invalid_expiry'],
    [{ name: 'x', scopes: ['mcp'], expiresInDays: '30' }, 'invalid_expiry'],
  ])('rejects %j with %s', (body, code) => {
    expect(() => parseCreatePatInput(body)).toThrow(expect.objectContaining({ code }))
  })
})

describe('the owner must still be allowed to sign in', () => {
  let store: MemoryPatStore
  let asked: PatOwner[]
  let allowed: boolean

  beforeEach(() => {
    store = createMemoryPatStore()
    asked = []
    allowed = true
  })

  function service() {
    return createPatService(store, {
      isOwnerAllowed: async (owner) => {
        asked.push(owner)
        return allowed
      },
    })
  }

  it('isLive re-applies the policy too', async () => {
    const pats = service()
    const { summary } = await pats.create('user-1', input())
    expect(await pats.isLive(summary.id, 'user-1')).toBe(true)
    allowed = false
    expect(await pats.isLive(summary.id, 'user-1')).toBe(false)
  })

  it('asks the policy with the owner’s joined directory entry on every verification', async () => {
    store.owners.set('user-1', { email: 'petr@example.com', name: 'Petr', emailVerified: true })
    const pats = service()
    const { token } = await pats.create('user-1', input())
    await expect(pats.verify(token)).resolves.not.toBeNull()
    await expect(pats.verify(token)).resolves.not.toBeNull()
    expect(asked).toEqual([
      { userSub: 'user-1', email: 'petr@example.com', emailVerified: true },
      { userSub: 'user-1', email: 'petr@example.com', emailVerified: true },
    ])
  })

  it('rejects a live token once its owner is no longer allowed', async () => {
    const pats = service()
    const { token } = await pats.create('user-1', input())
    allowed = false
    await expect(pats.verify(token)).resolves.toBeNull()
    // …and does not record the refused use.
    await flush()
    expect(store.rows[0]!.lastUsedAt).toBeNull()
  })

  it('never asks the policy for a token that is already invalid', async () => {
    const pats = service()
    const { token, summary } = await pats.create('user-1', input())
    await pats.revoke('user-1', summary.id)
    await pats.verify(token)
    await pats.verify(`nrt_${'Z'.repeat(43)}`)
    expect(asked).toEqual([])
  })

  it('refuseAllPatOwners (the unconfigured default) verifies nothing', async () => {
    const pats = createPatService(store, { isOwnerAllowed: refuseAllPatOwners })
    const { token } = await pats.create('user-1', input())
    await expect(pats.verify(token)).resolves.toBeNull()
  })
})

describe('createPatOwnerPolicy', () => {
  const allowlist = { allowedEmails: ['petr@example.com'], allowedDomain: undefined }
  const db = {} as Database

  beforeEach(() => vi.mocked(isAllowedToSignIn).mockReset())

  it('applies the sign-in rule to the owner’s email and verification state', async () => {
    vi.mocked(isAllowedToSignIn).mockResolvedValue(true)
    const policy = createPatOwnerPolicy(db, allowlist)
    await expect(
      policy({ userSub: 'u', email: 'petr@example.com', emailVerified: false }),
    ).resolves.toBe(true)
    expect(isAllowedToSignIn).toHaveBeenCalledWith(db, allowlist, {
      email: 'petr@example.com',
      emailVerified: false,
    })

    vi.mocked(isAllowedToSignIn).mockResolvedValue(false)
    await expect(
      policy({ userSub: 'u', email: 'gone@example.com', emailVerified: true }),
    ).resolves.toBe(false)
  })

  it('refuses an owner without a directory entry, without asking', async () => {
    const policy = createPatOwnerPolicy(db, allowlist)
    await expect(policy({ userSub: 'u', email: null, emailVerified: false })).resolves.toBe(false)
    expect(isAllowedToSignIn).not.toHaveBeenCalled()
  })
})

describe('revokeAllPersonalAccessTokensForUser', () => {
  it('revokes the user’s live tokens and reports how many', async () => {
    const scripted = scriptedDb({ updates: [[{ id: 'a' }, { id: 'b' }]] })
    const at = new Date('2026-09-27T00:00:00Z')
    await expect(revokeAllPersonalAccessTokensForUser(scripted.db, 'user-1', at)).resolves.toBe(2)
    expect(scripted.writes).toEqual([
      { kind: 'update', table: 'personal_access_tokens', values: { revokedAt: at } },
    ])
  })
})
