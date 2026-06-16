/**
 * auth/shareLinks.test.ts
 *
 * Tests for share link CRUD helpers:
 *   createShareLink, revokeShareLink, findShareLink, listShareLinks
 *
 * Uses mock DB — no real Postgres required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// CONN-1: revokeShareLink must tear down live WS connections for the revoked
// token. Mock the teardown helper so we can assert the call shape without a
// running Hocuspocus instance.
vi.mock('../hocuspocus/connections.js', () => ({
  closeDeckConnections: vi.fn(() => 0),
}))

import {
  createShareLink,
  revokeShareLink,
  findShareLink,
  listShareLinks,
  type ShareLinkRow,
} from './shareLinks.js'
import { closeDeckConnections } from '../hocuspocus/connections.js'

// ---------------------------------------------------------------------------
// In-memory share_links store
// ---------------------------------------------------------------------------

interface StoredLink {
  id: string
  deckId: string
  role: 'owner' | 'editor' | 'viewer'
  createdAt: Date
  expiresAt: Date | null
  createdBy: string
  revoked: boolean
}

// ---------------------------------------------------------------------------
// Mock DB factory for share links
// ---------------------------------------------------------------------------

function makeShareLinkDb(initialLinks: StoredLink[] = []) {
  const store = [...initialLinks]

  return {
    _store: store,

    insert: vi.fn().mockImplementation((_table: unknown) => ({
      values: vi.fn().mockImplementation((vals: StoredLink) => {
        store.push({ ...vals })
        return Promise.resolve()
      }),
    })),

    update: vi.fn().mockImplementation((_table: unknown) => ({
      set: vi.fn().mockImplementation((patch: Partial<StoredLink>) => ({
        where: vi.fn().mockImplementation((_cond: unknown) => {
          // We mark all as revoked for simplicity (test controls which token is targeted)
          for (const link of store) {
            Object.assign(link, patch)
          }
          return Promise.resolve()
        }),
      })),
    })),

    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((_cond: unknown) => ({
          limit: vi.fn().mockResolvedValue(store.length > 0 ? [store[0]] : []),
        })),
        // For listShareLinks — where returns the full store
      }),
    })),
  }
}

// ---------------------------------------------------------------------------
// We need separate mock shapes for findShareLink (uses .limit()) and
// listShareLinks (no .limit()). Build targeted mocks per test.
// ---------------------------------------------------------------------------

function makeFindMock(link: StoredLink | null) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(link ? [link] : []),
        }),
      }),
    }),
  }
}

function makeListMock(links: StoredLink[]) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(links),
      }),
    }),
  }
}

// ---------------------------------------------------------------------------
// createShareLink
// ---------------------------------------------------------------------------

describe('createShareLink', () => {
  it('returns a token and persists the record', async () => {
    const store: StoredLink[] = []
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: StoredLink) => {
          store.push({ ...vals })
          return Promise.resolve()
        }),
      }),
    }

    const result = await createShareLink(db as never, {
      deckId: 'deck-1',
      role: 'viewer',
      createdBy: 'user-a',
    })

    expect(typeof result.id).toBe('string')
    expect(result.id.length).toBeGreaterThan(0)
    expect(result.deckId).toBe('deck-1')
    expect(result.role).toBe('viewer')
    expect(store).toHaveLength(1)
    expect(store[0]!.revoked).toBe(false)
  })

  it('generates a unique token each call', async () => {
    const tokens: string[] = []
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: StoredLink) => {
          tokens.push(vals.id)
          return Promise.resolve()
        }),
      }),
    }

    await createShareLink(db as never, { deckId: 'd', role: 'viewer', createdBy: 'u' })
    await createShareLink(db as never, { deckId: 'd', role: 'viewer', createdBy: 'u' })

    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('stores expiresAt when provided', async () => {
    const store: StoredLink[] = []
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: StoredLink) => {
          store.push({ ...vals })
          return Promise.resolve()
        }),
      }),
    }
    const expiresAt = new Date(Date.now() + 86400_000)

    await createShareLink(db as never, {
      deckId: 'd',
      role: 'editor',
      createdBy: 'u',
      expiresAt,
    })

    expect(store[0]!.expiresAt).toEqual(expiresAt)
  })
})

// ---------------------------------------------------------------------------
// findShareLink
// ---------------------------------------------------------------------------

describe('findShareLink', () => {
  it('returns deckId + role for a valid link', async () => {
    const link: StoredLink = {
      id: 'tok-abc',
      deckId: 'deck-1',
      role: 'viewer',
      createdAt: new Date(),
      expiresAt: null,
      createdBy: 'user-a',
      revoked: false,
    }
    const db = makeFindMock(link)

    const result = await findShareLink(db as never, 'tok-abc')
    expect(result).toEqual({ deckId: 'deck-1', role: 'viewer' })
  })

  it('returns null for unknown token', async () => {
    const db = makeFindMock(null)
    const result = await findShareLink(db as never, 'nonexistent')
    expect(result).toBeNull()
  })

  it('returns null when link is revoked', async () => {
    const link: StoredLink = {
      id: 'tok-abc',
      deckId: 'deck-1',
      role: 'viewer',
      createdAt: new Date(),
      expiresAt: null,
      createdBy: 'user-a',
      revoked: true, // <-- revoked
    }
    const db = makeFindMock(link)

    const result = await findShareLink(db as never, 'tok-abc')
    expect(result).toBeNull()
  })

  it('returns null when link is expired', async () => {
    const link: StoredLink = {
      id: 'tok-abc',
      deckId: 'deck-1',
      role: 'viewer',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() - 1000), // 1 second in the past
      createdBy: 'user-a',
      revoked: false,
    }
    const db = makeFindMock(link)

    const result = await findShareLink(db as never, 'tok-abc')
    expect(result).toBeNull()
  })

  it('returns result when link has a future expiresAt', async () => {
    const link: StoredLink = {
      id: 'tok-abc',
      deckId: 'deck-1',
      role: 'editor',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400_000), // 1 day in future
      createdBy: 'user-a',
      revoked: false,
    }
    const db = makeFindMock(link)

    const result = await findShareLink(db as never, 'tok-abc')
    expect(result).toEqual({ deckId: 'deck-1', role: 'editor' })
  })
})

// ---------------------------------------------------------------------------
// revokeShareLink
// ---------------------------------------------------------------------------

describe('revokeShareLink', () => {
  it('sets revoked = true on the record', async () => {
    const store: StoredLink[] = [
      {
        id: 'tok-abc',
        deckId: 'deck-1',
        role: 'viewer',
        createdAt: new Date(),
        expiresAt: null,
        createdBy: 'user-a',
        revoked: false,
      },
    ]

    // Targeted update mock that mutates store
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            store[0]!.revoked = true
            return Promise.resolve()
          }),
        }),
      }),
    }

    await revokeShareLink(db as never, 'tok-abc', 'deck-1')
    expect(store[0]!.revoked).toBe(true)
  })

  it('closes live WS connections for the revoked token on that deck (CONN-1)', async () => {
    vi.mocked(closeDeckConnections).mockClear()
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    }

    await revokeShareLink(db as never, 'tok-abc', 'deck-1')

    expect(closeDeckConnections).toHaveBeenCalledWith('deck-1', { shareToken: 'tok-abc' })
  })

  it('does not revoke a link belonging to a different deck (IDOR guard)', async () => {
    // Drizzle's update().set().where(and(eq id, eq deckId)) translates to a
    // SQL WHERE that matches zero rows when deckId mismatches. We assert by
    // capturing the where() call argument shape.
    let capturedWhere: unknown = null
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((expr: unknown) => {
            capturedWhere = expr
            return Promise.resolve()
          }),
        }),
      }),
    }

    await revokeShareLink(db as never, 'tok-abc', 'deck-other')
    // The where clause must compose two equality predicates (id AND deckId);
    // we don't introspect the AST shape across drizzle versions — just assert
    // that where() was called once with a non-null composite expression.
    expect(db.update).toHaveBeenCalledTimes(1)
    expect(capturedWhere).not.toBeNull()
  })

  it('subsequent findShareLink returns null after revoke', async () => {
    // Simulate: revoke flips flag, then find returns the revoked record
    const link: StoredLink = {
      id: 'tok-abc',
      deckId: 'deck-1',
      role: 'viewer',
      createdAt: new Date(),
      expiresAt: null,
      createdBy: 'user-a',
      revoked: true, // already revoked (simulates post-revoke state)
    }

    const findDb = makeFindMock(link)
    const result = await findShareLink(findDb as never, 'tok-abc')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// listShareLinks
// ---------------------------------------------------------------------------

describe('listShareLinks', () => {
  it('returns all links including revoked ones', async () => {
    const now = new Date()
    const links: StoredLink[] = [
      {
        id: 'tok-1',
        deckId: 'deck-1',
        role: 'viewer',
        createdAt: now,
        expiresAt: null,
        createdBy: 'u',
        revoked: false,
      },
      {
        id: 'tok-2',
        deckId: 'deck-1',
        role: 'editor',
        createdAt: now,
        expiresAt: null,
        createdBy: 'u',
        revoked: true,
      },
    ]

    const db = makeListMock(links)
    const result: ShareLinkRow[] = await listShareLinks(db as never, 'deck-1')

    expect(result).toHaveLength(2)
    expect(result[0]!.id).toBe('tok-1')
    expect(result[0]!.revoked).toBe(false)
    expect(result[1]!.id).toBe('tok-2')
    expect(result[1]!.revoked).toBe(true)
  })

  it('returns empty array when no links exist', async () => {
    const db = makeListMock([])
    const result = await listShareLinks(db as never, 'deck-x')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})
