/**
 * auth/permissions.test.ts
 *
 * Tests for permission helpers: grantPermission, revokePermission,
 * listPermissions, resolveDeckAccess, checkDeckPermission, roleAtLeast.
 *
 * Uses an in-memory mock database — no real Postgres required.
 * The mock models the chainable Drizzle query builder interface closely
 * enough to exercise all code paths in permissions.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  roleAtLeast,
  grantPermission,
  revokePermission,
  listPermissions,
  resolveDeckAccess,
  checkDeckPermission,
  type DeckRole,
  type PermissionRow,
} from './permissions.js'

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

interface PermRow {
  deckId: string
  userId: string
  role: DeckRole
  grantedAt: Date
  grantedBy: string | null
}

interface DeckRow {
  id: string
  ownerUserId: string
}

interface ShareRow {
  id: string
  deckId: string
  role: DeckRole
  revoked: boolean
  expiresAt: Date | null
}

interface Store {
  perms: PermRow[]
  decks: DeckRow[]
  shares: ShareRow[]
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

/**
 * Builds a mock Database object that mimics the Drizzle API surface used
 * by the auth helpers. We model only the operations actually called.
 */
function makeMockDb(store: Store) {
  // We need to intercept calls by table identity, so we use a simple
  // table-name approach via the mock's constructor argument.

  const db = {
    // --- select ---
    select: vi.fn().mockImplementation(() => ({
      from: vi
        .fn()
        .mockImplementation((table: { name?: string; _: { name: string } } | unknown) => {
          // Determine which table is being queried from the Drizzle table object.
          // Drizzle tables expose their name via the Symbol-based `_` property or
          // the actual SQL name. We identify by reference since we mock them below.
          const tableName = getTableName(table)
          return {
            where: vi.fn().mockImplementation((_cond: unknown) => ({
              limit: vi.fn().mockImplementation((_n: number) => {
                if (tableName === 'deck_permissions') {
                  return Promise.resolve(store.perms.slice(0, 1))
                }
                if (tableName === 'decks') {
                  return Promise.resolve(store.decks.slice(0, 1))
                }
                if (tableName === 'share_links') {
                  return Promise.resolve(store.shares.slice(0, 1))
                }
                return Promise.resolve([])
              }),
            })),
            // listPermissions — no where, no limit (full table scan for deckId)
            where2: vi.fn(),
          }
        }),
    })),

    // --- insert ---
    insert: vi.fn().mockImplementation((_table: unknown) => ({
      values: vi.fn().mockImplementation((vals: PermRow) => ({
        onConflictDoUpdate: vi.fn().mockImplementation(({ set }: { set: Partial<PermRow> }) => {
          const existing = store.perms.findIndex(
            (p) => p.deckId === vals.deckId && p.userId === vals.userId,
          )
          if (existing >= 0) {
            store.perms[existing] = { ...store.perms[existing]!, ...set }
          } else {
            store.perms.push({ ...vals })
          }
          return Promise.resolve()
        }),
        // For share_links insert (no conflict handling needed in tests)
        returning: vi.fn().mockResolvedValue([vals]),
      })),
    })),

    // --- delete ---
    delete: vi.fn().mockImplementation((_table: unknown) => ({
      where: vi.fn().mockImplementation((_cond: unknown) => {
        // Simulate deleting from perms — the test controls store directly
        return Promise.resolve()
      }),
    })),

    // --- update ---
    update: vi.fn().mockImplementation((_table: unknown) => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })),

    // --- transaction ---
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(db)
    }),
  }

  return db
}

function getTableName(table: unknown): string {
  // Drizzle tables have a SQL name accessible via [Symbol.for('drizzle:Name')] or similar.
  // In tests we can just stringify or check a property we attach in the real schema.
  // Since we can't import real schema (would need DB), we use a duck-typing trick:
  // the mock receives the real table object from the imports in permissions.ts,
  // but because we're unit-testing with vi.mock it's replaced.
  // For this test we use a simpler approach: track which table was passed.
  const t = table as { _: { name: string } } | { name: string } | null
  if (!t) return 'unknown'
  if (typeof (t as { _: { name: string } })?._ === 'object') {
    return (t as { _: { name: string } })._.name
  }
  return (t as { name: string }).name ?? 'unknown'
}

// ---------------------------------------------------------------------------
// The permissions helpers use real drizzle operators (and, eq) which are pure
// functions that just build condition objects — they don't need mocking.
// However, the select().from().where().limit() chain needs to be wired
// correctly. Since our mock doesn't actually filter by condition (it just
// returns whatever is in store.perms[0]), we control tests by pre-populating
// the store with the right records.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Unit tests for roleAtLeast (pure, no DB)
// ---------------------------------------------------------------------------

describe('roleAtLeast', () => {
  it('viewer satisfies viewer', () => expect(roleAtLeast('viewer', 'viewer')).toBe(true))
  it('editor satisfies viewer', () => expect(roleAtLeast('editor', 'viewer')).toBe(true))
  it('editor satisfies editor', () => expect(roleAtLeast('editor', 'editor')).toBe(true))
  it('owner satisfies viewer', () => expect(roleAtLeast('owner', 'viewer')).toBe(true))
  it('owner satisfies editor', () => expect(roleAtLeast('owner', 'editor')).toBe(true))
  it('owner satisfies owner', () => expect(roleAtLeast('owner', 'owner')).toBe(true))
  it('viewer does NOT satisfy editor', () => expect(roleAtLeast('viewer', 'editor')).toBe(false))
  it('viewer does NOT satisfy owner', () => expect(roleAtLeast('viewer', 'owner')).toBe(false))
  it('editor does NOT satisfy owner', () => expect(roleAtLeast('editor', 'owner')).toBe(false))
})

// ---------------------------------------------------------------------------
// grantPermission / revokePermission / listPermissions
// ---------------------------------------------------------------------------

describe('grantPermission', () => {
  it('inserts a new permission row', async () => {
    const store: Store = { perms: [], decks: [], shares: [] }
    const db = makeMockDb(store)

    await grantPermission(db as never, {
      deckId: 'deck-1',
      userId: 'user-a',
      role: 'editor',
      grantedBy: 'user-owner',
    })

    // The mock upsert pushes to store.perms
    expect(store.perms).toHaveLength(1)
    expect(store.perms[0]).toMatchObject({ deckId: 'deck-1', userId: 'user-a', role: 'editor' })
  })

  it('overwrites existing role on conflict', async () => {
    const existing: PermRow = {
      deckId: 'deck-1',
      userId: 'user-a',
      role: 'viewer',
      grantedAt: new Date(),
      grantedBy: null,
    }
    const store: Store = { perms: [existing], decks: [], shares: [] }
    const db = makeMockDb(store)

    await grantPermission(db as never, {
      deckId: 'deck-1',
      userId: 'user-a',
      role: 'editor',
      grantedBy: 'user-owner',
    })

    expect(store.perms).toHaveLength(1)
    expect(store.perms[0]!.role).toBe('editor')
  })
})

describe('revokePermission', () => {
  it('calls delete without throwing', async () => {
    const store: Store = { perms: [], decks: [], shares: [] }
    const db = makeMockDb(store)

    await expect(
      revokePermission(db as never, { deckId: 'deck-1', userId: 'user-a' }),
    ).resolves.toBeUndefined()
    expect(db.delete).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// listPermissions
// ---------------------------------------------------------------------------

describe('listPermissions', () => {
  it('returns mapped rows', async () => {
    // listPermissions uses select().from().where() without .limit()
    // We need a slightly different mock that returns store.perms on .where()
    const now = new Date()
    const store: Store = {
      perms: [
        { deckId: 'deck-1', userId: 'user-a', role: 'owner', grantedAt: now, grantedBy: null },
        { deckId: 'deck-1', userId: 'user-b', role: 'viewer', grantedAt: now, grantedBy: 'user-a' },
      ],
      decks: [],
      shares: [],
    }

    // Build a targeted mock for listPermissions
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(store.perms),
        }),
      }),
    }

    const result: PermissionRow[] = await listPermissions(db as never, 'deck-1')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ userId: 'user-a', role: 'owner', grantedBy: null })
    expect(result[1]).toMatchObject({ userId: 'user-b', role: 'viewer', grantedBy: 'user-a' })
  })

  it('returns empty array when no permissions', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    }

    const result = await listPermissions(db as never, 'deck-x')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveDeckAccess
// ---------------------------------------------------------------------------

describe('resolveDeckAccess', () => {
  /**
   * Helper: build a mock DB that serves controlled data for the
   * select().from().where().limit() chain used by resolveDeckAccess.
   *
   * selectSequence: array of results returned in order for each .limit() call.
   * The first call is always deck_permissions lookup, the second is decks lookup.
   */
  /**
   * Build a mock DB for resolveDeckAccess.
   *
   * The function makes up to three sequential select().from().where().limit()
   * calls. Because the mock re-uses one shared `select` spy, we return results
   * by call index.
   *
   * When userId is null the first two select calls (perm + deck lookup) are
   * skipped entirely, so the share-link lookup is always call index 0 from the
   * mock's perspective.  Pass `skipUserLookups: true` for that case so the
   * mock maps correctly.
   */
  function makeResolveMock(opts: {
    permRow?: PermRow | null
    deckRow?: DeckRow | null
    shareRow?: ShareRow | null
    skipUserLookups?: boolean // set true when userId=null (skips perm+deck selects)
  }) {
    const calls: Array<unknown[]> = []

    const limitMock = vi.fn().mockImplementation(() => {
      const idx = calls.length
      calls.push([])

      if (opts.skipUserLookups) {
        // Only call is share_links lookup (via findShareLink)
        if (idx === 0) return Promise.resolve(opts.shareRow ? [opts.shareRow] : [])
      } else {
        // Call 0: deck_permissions
        if (idx === 0) return Promise.resolve(opts.permRow ? [opts.permRow] : [])
        // Call 1: decks (owner fallback — only reached when no perm row found)
        if (idx === 1) return Promise.resolve(opts.deckRow ? [opts.deckRow] : [])
        // Call 2: share_links (via findShareLink — only if shareToken provided)
        if (idx === 2) return Promise.resolve(opts.shareRow ? [opts.shareRow] : [])
      }
      return Promise.resolve([])
    })

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: limitMock,
          }),
        }),
      }),
    }

    return db
  }

  it('returns direct role when deck_permissions row exists', async () => {
    const now = new Date()
    const db = makeResolveMock({
      permRow: {
        deckId: 'deck-1',
        userId: 'user-a',
        role: 'editor',
        grantedAt: now,
        grantedBy: null,
      },
    })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: 'user-a',
    })

    expect(result).toEqual({ role: 'editor', reason: 'direct' })
  })

  it('returns owner-fallback when userId matches decks.ownerUserId', async () => {
    const db = makeResolveMock({
      permRow: null,
      deckRow: { id: 'deck-1', ownerUserId: 'user-a' },
    })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: 'user-a',
    })

    expect(result).toEqual({ role: 'owner', reason: 'owner-fallback' })
  })

  it('returns null when userId does not match owner and no perms row', async () => {
    const db = makeResolveMock({
      permRow: null,
      deckRow: { id: 'deck-1', ownerUserId: 'other-user' },
    })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: 'user-a',
    })

    expect(result).toBeNull()
  })

  it('returns null when deck does not exist', async () => {
    const db = makeResolveMock({ permRow: null, deckRow: null })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'nonexistent',
      userId: 'user-a',
    })

    expect(result).toBeNull()
  })

  it('returns share-link role when userId is null and valid share token provided', async () => {
    const db = makeResolveMock({
      skipUserLookups: true,
      shareRow: {
        id: 'tok-abc',
        deckId: 'deck-1',
        role: 'viewer',
        revoked: false,
        expiresAt: null,
      },
    })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: null,
      shareToken: 'tok-abc',
    })

    expect(result).toEqual({ role: 'viewer', reason: 'share-link' })
  })

  it('returns null when userId is null and no shareToken', async () => {
    // No DB calls are made when userId=null and no shareToken — mock is unused
    const db = makeResolveMock({ skipUserLookups: true })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: null,
    })

    expect(result).toBeNull()
  })

  it('returns null when share link deckId does not match requested deckId', async () => {
    const db = makeResolveMock({
      skipUserLookups: true,
      shareRow: {
        id: 'tok-abc',
        deckId: 'deck-OTHER', // different deck
        role: 'viewer',
        revoked: false,
        expiresAt: null,
      },
    })

    const result = await resolveDeckAccess(db as never, {
      deckId: 'deck-1',
      userId: null,
      shareToken: 'tok-abc',
    })

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// checkDeckPermission — role matrix
// ---------------------------------------------------------------------------

describe('checkDeckPermission — role matrix', () => {
  function makeDirectRoleMock(role: DeckRole) {
    const now = new Date()
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { deckId: 'd', userId: 'u', role, grantedAt: now, grantedBy: null },
              ]),
          }),
        }),
      }),
    }
  }

  const cases: Array<{ actual: DeckRole; required: DeckRole; expected: boolean }> = [
    { actual: 'owner', required: 'owner', expected: true },
    { actual: 'owner', required: 'editor', expected: true },
    { actual: 'owner', required: 'viewer', expected: true },
    { actual: 'editor', required: 'owner', expected: false },
    { actual: 'editor', required: 'editor', expected: true },
    { actual: 'editor', required: 'viewer', expected: true },
    { actual: 'viewer', required: 'owner', expected: false },
    { actual: 'viewer', required: 'editor', expected: false },
    { actual: 'viewer', required: 'viewer', expected: true },
  ]

  for (const { actual, required, expected } of cases) {
    it(`${actual} asking for ${required} → ${expected}`, async () => {
      const db = makeDirectRoleMock(actual)
      const result = await checkDeckPermission(db as never, {
        deckId: 'd',
        userId: 'u',
        required,
      })
      expect(result).toBe(expected)
    })
  }

  it('returns false for nonexistent deck (null access)', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }

    const result = await checkDeckPermission(db as never, {
      deckId: 'nonexistent',
      userId: 'user-a',
      required: 'viewer',
    })
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})
