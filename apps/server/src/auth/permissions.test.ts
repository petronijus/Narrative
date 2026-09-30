/**
 * auth/permissions.test.ts
 *
 * Tests for permission helpers: grantPermission, revokePermission,
 * listPermissions, the access resolvers (deck, folder, component, folder
 * content — docs/plans/folder-sharing.md), checkDeckPermission, roleAtLeast.
 *
 * No real Postgres: the grant helpers run on an in-memory mock, the
 * resolvers on the scripted database (test-support/scriptedDb.ts), which
 * answers their selects in the order the resolver makes them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  roleAtLeast,
  grantPermission,
  revokePermission,
  listPermissions,
  resolveDeckAccess,
  resolveFolderAccess,
  resolveComponentAccess,
  resolveFolderContentAccess,
  higherRole,
  checkDeckPermission,
  type DeckRole,
  type PermissionRow,
} from './permissions.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

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
// resolveDeckAccess — the highest of the deck grant, the folder role and a
// share link. For a signed-in user the deck row and both grants come in ONE
// select (decks left-joined to the user's deck_permissions and
// folder_permissions rows); a share token adds the share-link select.
// ---------------------------------------------------------------------------

const LIVE_LINK = (deckId: string, role: DeckRole = 'viewer') => ({
  id: 'tok-abc',
  deckId,
  role,
  revoked: false,
  expiresAt: null,
})

/** The selects of resolveDeckAccess for a signed-in user, in order. */
function deckScript(opts: {
  deck?: null
  deckRole?: DeckRole | null
  folderRole?: DeckRole | null
  link?: ReturnType<typeof LIVE_LINK> | null
}): unknown[][] {
  const link = opts.link !== undefined ? [opts.link ? [opts.link] : []] : []
  if (opts.deck === null) return [[], ...link]
  return [[{ deckRole: opts.deckRole ?? null, folderRole: opts.folderRole ?? null }], ...link]
}

describe('resolveDeckAccess', () => {
  it('returns the direct role when the deck has a row for the user', async () => {
    const { db } = scriptedDb({ selects: deckScript({ deckRole: 'editor' }) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'editor', reason: 'direct' })
  })

  it('gives a folder member their folder role on a deck they hold no row for', async () => {
    const { db } = scriptedDb({ selects: deckScript({ folderRole: 'editor' }) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'editor', reason: 'folder' })
  })

  it('takes the folder role over a lower deck row', async () => {
    const { db } = scriptedDb({ selects: deckScript({ deckRole: 'viewer', folderRole: 'editor' }) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'editor', reason: 'folder' })
  })

  it('keeps a deck row that is higher than the folder role', async () => {
    const { db } = scriptedDb({ selects: deckScript({ deckRole: 'owner', folderRole: 'viewer' }) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'owner', reason: 'direct' })
  })

  it('reports a deck row and an equal folder role as direct (a tie keeps the deck grant)', async () => {
    const { db } = scriptedDb({ selects: deckScript({ deckRole: 'editor', folderRole: 'editor' }) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'editor', reason: 'direct' })
  })

  it('reads the deck and both grants in one select', async () => {
    const scripted = scriptedDb({
      selects: [...deckScript({ deckRole: 'viewer', folderRole: 'owner' }), [{ unused: true }]],
    })
    const result = await resolveDeckAccess(scripted.db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toEqual({ role: 'owner', reason: 'folder' })
    expect(scripted.remaining().selects).toBe(1)
  })

  it("gives the deck's creator nothing without a grant: decks.owner_user_id is no fallback", async () => {
    // The creator's owner row is written with the deck (migration 0031 for older
    // decks); a creator whose row is gone holds no role on the deck.
    const { db } = scriptedDb({ selects: deckScript({}) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'the-creator' })
    expect(result).toBeNull()
  })

  it('returns null for a user with no deck row and no folder role', async () => {
    const { db } = scriptedDb({ selects: deckScript({}) })
    const result = await resolveDeckAccess(db, { deckId: 'deck-1', userId: 'user-a' })
    expect(result).toBeNull()
  })

  it('returns null when the deck does not exist', async () => {
    const scripted = scriptedDb({ selects: deckScript({ deck: null }) })
    const result = await resolveDeckAccess(scripted.db, { deckId: 'nonexistent', userId: 'user-a' })
    expect(result).toBeNull()
    expect(scripted.remaining().selects).toBe(0)
  })

  it('returns null for a missing deck even with a share token, without reading the link', async () => {
    const scripted = scriptedDb({ selects: deckScript({ deck: null, link: LIVE_LINK('gone') }) })
    const result = await resolveDeckAccess(scripted.db, {
      deckId: 'gone',
      userId: 'user-a',
      shareToken: 'tok-abc',
    })
    expect(result).toBeNull()
    expect(scripted.remaining().selects).toBe(1)
  })

  it('returns the share-link role when userId is null and the token is valid', async () => {
    const { db } = scriptedDb({ selects: [[LIVE_LINK('deck-1')]] })
    const result = await resolveDeckAccess(db, {
      deckId: 'deck-1',
      userId: null,
      shareToken: 'tok-abc',
    })
    expect(result).toEqual({ role: 'viewer', reason: 'share-link' })
  })

  it('takes an editor share link over a viewer folder role', async () => {
    const { db } = scriptedDb({
      selects: deckScript({ folderRole: 'viewer', link: LIVE_LINK('deck-1', 'editor') }),
    })
    const result = await resolveDeckAccess(db, {
      deckId: 'deck-1',
      userId: 'user-a',
      shareToken: 'tok-abc',
    })
    expect(result).toEqual({ role: 'editor', reason: 'share-link' })
  })

  it('keeps a deck grant over a lower share link', async () => {
    const { db } = scriptedDb({
      selects: deckScript({ deckRole: 'editor', link: LIVE_LINK('deck-1', 'viewer') }),
    })
    const result = await resolveDeckAccess(db, {
      deckId: 'deck-1',
      userId: 'user-a',
      shareToken: 'tok-abc',
    })
    expect(result).toEqual({ role: 'editor', reason: 'direct' })
  })

  it('returns null when userId is null and no shareToken', async () => {
    const scripted = scriptedDb()
    const result = await resolveDeckAccess(scripted.db, { deckId: 'deck-1', userId: null })
    expect(result).toBeNull()
  })

  it('returns null when the share link is for another deck', async () => {
    const { db } = scriptedDb({ selects: [[LIVE_LINK('deck-OTHER')]] })
    const result = await resolveDeckAccess(db, {
      deckId: 'deck-1',
      userId: null,
      shareToken: 'tok-abc',
    })
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveFolderAccess / resolveComponentAccess / resolveFolderContentAccess
// ---------------------------------------------------------------------------

describe('resolveFolderAccess', () => {
  it("returns the member's folder_permissions role", async () => {
    const { db } = scriptedDb({ selects: [[{ role: 'viewer' }]] })
    const result = await resolveFolderAccess(db, { folderId: 'f', userId: 'user-a' })
    expect(result).toEqual({ role: 'viewer', reason: 'direct' })
  })

  it('returns null for a user without a row, and for no user at all', async () => {
    const { db } = scriptedDb({ selects: [[]] })
    expect(await resolveFolderAccess(db, { folderId: 'f', userId: 'user-a' })).toBeNull()
    expect(await resolveFolderAccess(scriptedDb().db, { folderId: 'f', userId: null })).toBeNull()
  })

  it('takes the highest role among the user and the ids it also counts as', async () => {
    const { db } = scriptedDb({ selects: [[{ role: 'editor' }, { role: 'owner' }]] })
    const result = await resolveFolderAccess(db, {
      folderId: 'f',
      userId: 'dev-user',
      alsoAs: ['demo-user'],
    })
    expect(result).toEqual({ role: 'owner', reason: 'direct' })
  })
})

describe('resolveComponentAccess', () => {
  it("is the user's role in the component's folder", async () => {
    const { db } = scriptedDb({ selects: [[{ folderId: 'f' }], [{ role: 'viewer' }]] })
    const result = await resolveComponentAccess(db, { componentId: 'c', userId: 'user-a' })
    expect(result).toEqual({ role: 'viewer', reason: 'folder' })
  })

  it('refuses a user outside the folder, a missing component and a share-link principal', async () => {
    const outside = scriptedDb({ selects: [[{ folderId: 'f' }], []] })
    expect(await resolveComponentAccess(outside.db, { componentId: 'c', userId: 'u' })).toBeNull()
    const missing = scriptedDb({ selects: [[]] })
    expect(await resolveComponentAccess(missing.db, { componentId: 'c', userId: 'u' })).toBeNull()
    expect(await resolveComponentAccess(scriptedDb().db, { componentId: 'c', userId: null })).toBe(
      null,
    )
  })
})

describe('resolveFolderContentAccess', () => {
  it('gives a folder member their folder role', async () => {
    const { db } = scriptedDb({ selects: [[{ role: 'editor' }]] })
    const result = await resolveFolderContentAccess(db, { folderId: 'f', userId: 'user-a' })
    expect(result).toEqual({ role: 'editor', via: 'folder' })
  })

  it('lets a guest of one of its decks read it as a viewer', async () => {
    const { db } = scriptedDb({ selects: [[], [{ deckId: 'deck-1' }]] })
    const result = await resolveFolderContentAccess(db, { folderId: 'f', userId: 'user-a' })
    expect(result).toEqual({ role: 'viewer', via: 'deck' })
  })

  it('lets a BYPASS alias holding a grant on one of its decks read it as a viewer', async () => {
    const { db } = scriptedDb({ selects: [[], [{ deckId: 'deck-1' }]] })
    const result = await resolveFolderContentAccess(db, {
      folderId: 'f',
      userId: 'dev-user',
      alsoAs: ['demo-user'],
    })
    expect(result).toEqual({ role: 'viewer', via: 'deck' })
  })

  it('refuses the creator of one of its decks who holds no grant (no owner fallback)', async () => {
    // Two selects only: folder_permissions, then deck_permissions. Nothing reads decks.owner_user_id.
    const scripted = scriptedDb({ selects: [[], [], [{ id: 'deck-1' }]] })
    const result = await resolveFolderContentAccess(scripted.db, { folderId: 'f', userId: 'u' })
    expect(result).toBeNull()
    expect(scripted.remaining().selects).toBe(1)
  })

  it('lets a share link to a deck of the folder read it as a viewer, even an editor link', async () => {
    const { db } = scriptedDb({
      selects: [[LIVE_LINK('deck-1', 'editor')], [{ folderId: 'f' }]],
    })
    const result = await resolveFolderContentAccess(db, {
      folderId: 'f',
      userId: null,
      shareToken: 'tok-abc',
    })
    expect(result).toEqual({ role: 'viewer', via: 'deck' })
  })

  it('refuses a share link to a deck of another folder', async () => {
    const { db } = scriptedDb({ selects: [[LIVE_LINK('deck-1')], [{ folderId: 'other' }]] })
    const result = await resolveFolderContentAccess(db, {
      folderId: 'f',
      userId: null,
      shareToken: 'tok-abc',
    })
    expect(result).toBeNull()
  })

  it('refuses a revoked share link', async () => {
    const { db } = scriptedDb({ selects: [[{ ...LIVE_LINK('deck-1'), revoked: true }]] })
    const result = await resolveFolderContentAccess(db, {
      folderId: 'f',
      userId: null,
      shareToken: 'tok-abc',
    })
    expect(result).toBeNull()
  })

  it('refuses a user with no role in the folder and no access to any of its decks', async () => {
    const { db } = scriptedDb({ selects: [[], []] })
    expect(await resolveFolderContentAccess(db, { folderId: 'f', userId: 'user-a' })).toBeNull()
  })
})

describe('higherRole', () => {
  it('picks the higher role and treats null as no access', () => {
    expect(higherRole('viewer', 'editor')).toBe('editor')
    expect(higherRole('owner', 'editor')).toBe('owner')
    expect(higherRole(null, 'viewer')).toBe('viewer')
    expect(higherRole('viewer', null)).toBe('viewer')
    expect(higherRole(null, null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// checkDeckPermission — role matrix
// ---------------------------------------------------------------------------

describe('checkDeckPermission — role matrix', () => {
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
      const { db } = scriptedDb({ selects: deckScript({ deckRole: actual }) })
      const result = await checkDeckPermission(db, { deckId: 'd', userId: 'u', required })
      expect(result).toBe(expected)
    })
  }

  it('a folder editor meets editor on a deck of the folder, not owner', async () => {
    const editor = scriptedDb({ selects: deckScript({ folderRole: 'editor' }) })
    expect(
      await checkDeckPermission(editor.db, { deckId: 'd', userId: 'u', required: 'editor' }),
    ).toBe(true)
    const again = scriptedDb({ selects: deckScript({ folderRole: 'editor' }) })
    expect(
      await checkDeckPermission(again.db, { deckId: 'd', userId: 'u', required: 'owner' }),
    ).toBe(false)
  })

  it('returns false for nonexistent deck (null access)', async () => {
    const { db } = scriptedDb({ selects: deckScript({ deck: null }) })
    const result = await checkDeckPermission(db, {
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
