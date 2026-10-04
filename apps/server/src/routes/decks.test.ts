/**
 * routes/decks.test.ts
 *
 * Tests for /decks REST API endpoints.
 * Uses a mock Drizzle DB — no real Postgres.
 *
 * Auth: all tests run with BYPASS_AUTH=true semantics (dev-user synthesized).
 * The mock DB is wired to return appropriate data for each test scenario.
 *
 * Coverage:
 *   GET  /decks                   → returns accessible decks (bypass: demo-user + dev-user)
 *   GET  /decks/:id               → returns deck (JWT or share_token)
 *   POST /decks                   → creates deck, sets ownerUserId from JWT sub (dev-user in bypass)
 *   DELETE /decks/:id             → 204 + cascade (owner check)
 *   DELETE /decks/:id no owner    → 403
 *   GET /decks/:id share_token    → 200 with valid share access
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerDeckRoutes } from './decks.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import type { DeckAccessResult } from '../auth/permissions.js'

// ---------------------------------------------------------------------------
// Mock resolveDeckAccess for GET /decks/:id share_token tests
// ---------------------------------------------------------------------------

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn(),
  }
})

// Mock the bucket cleanup helper so DELETE tests don't try to reach
// MinIO. Each test can assert against `purgeDeckBucketPrefix` directly.
vi.mock('../media/bucketCleanup.js', () => ({
  purgeDeckBucketPrefix: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeExplicitKeys: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeUnreferencedKeys: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  sweepAgainAfterGrace: vi.fn(),
}))

const { resolveDeckAccess } = await import('../auth/permissions.js')
const resolveMock = resolveDeckAccess as ReturnType<typeof vi.fn>
const { purgeDeckBucketPrefix, purgeExplicitKeys, sweepAgainAfterGrace } =
  await import('../media/bucketCleanup.js')
const purgeMock = purgeDeckBucketPrefix as ReturnType<typeof vi.fn>
const purgeKeysMock = purgeExplicitKeys as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface MockDeck {
  id: string
  title: string
  ownerUserId: string
  createdAt: Date
  updatedAt: Date
  // Optional fields that the route reads through `withThumbnailUrl`. Tests
  // that don't care about thumbnails leave these undefined; the mock
  // factory below normalises them to `null` so the decorator doesn't crash
  // on `row.thumbnailKey === null` checks.
  thumbnailKey?: string | null
  thumbnailUpdatedAt?: Date | null
  folderId?: string | null
}

function makeMockDb(initialDecks: MockDeck[] = []) {
  // Normalise so every row has the optional fields the route reads.
  let deckStore = initialDecks.map((d) => ({
    thumbnailKey: null,
    thumbnailUpdatedAt: null,
    folderId: null,
    ...d,
  }))

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        // `where()` is both awaitable (the DELETE handler's media-asset
        // key query awaits it directly → resolves to [] = no assets) and
        // carries orderBy/limit for the deck list/detail queries.
        where: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            orderBy: vi.fn().mockImplementation(() => Promise.resolve(deckStore)),
            limit: vi
              .fn()
              .mockImplementation(() =>
                Promise.resolve(deckStore.length > 0 ? [deckStore[0]] : []),
              ),
          }),
        ),
        orderBy: vi.fn().mockImplementation(() => Promise.resolve(deckStore)),
        limit: vi
          .fn()
          .mockImplementation(() => Promise.resolve(deckStore.length > 0 ? [deckStore[0]] : [])),
      }),
    }),

    insert: vi.fn().mockImplementation((_table: unknown) => ({
      values: vi.fn().mockImplementation((vals: MockDeck) => {
        const result: Promise<unknown[]> & {
          returning: () => Promise<MockDeck[]>
          onConflictDoNothing: () => { returning: () => Promise<MockDeck[]> }
        } = Promise.resolve([]) as never
        result.returning = vi.fn().mockResolvedValue([{ ...vals }])
        // Drafts provisioning inserts with ON CONFLICT DO NOTHING (one Drafts per owner).
        result.onConflictDoNothing = () => ({ returning: result.returning })
        return result
      }),
    })),

    delete: vi.fn().mockImplementation((_table: unknown) => ({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation((_cols: unknown) => {
          if (deckStore.length === 0) return Promise.resolve([])
          const deleted = [deckStore[0]]
          deckStore = deckStore.slice(1)
          return Promise.resolve(deleted)
        }),
      }),
    })),

    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(db)
    }),
  }

  return db as unknown as Database
}

// ---------------------------------------------------------------------------
// App builder — bypass auth, owner role for dev-user on 'deck-1'
// ---------------------------------------------------------------------------

async function buildApp(
  db: Database,
  accessResult: DeckAccessResult | null = { role: 'owner', reason: 'direct' },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  // Bypass auth → dev-user
  registerAuthPlugin(app, { bypass: true, db })

  // Default mock: dev-user has the specified role on any deck
  resolveMock.mockResolvedValue(accessResult)

  await registerDeckRoutes(app, db)
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// GET /decks
// ---------------------------------------------------------------------------

describe('GET /decks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty array when no decks', async () => {
    const db = makeMockDb([])
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/decks' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns list of decks owned by dev-user', async () => {
    const now = new Date()
    const db = makeMockDb([
      { id: 'deck-1', title: 'Deck One', ownerUserId: 'dev-user', createdAt: now, updatedAt: now },
    ])
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/decks' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GET /decks/:id (with share_token)
// ---------------------------------------------------------------------------

describe('GET /decks/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns deck for authenticated user', async () => {
    const now = new Date()
    const db = makeMockDb([
      { id: 'deck-1', title: 'My Deck', ownerUserId: 'dev-user', createdAt: now, updatedAt: now },
    ])
    resolveMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/decks/deck-1' })
    expect(res.statusCode).toBe(200)
  })

  it('returns 200 with valid share_token', async () => {
    const now = new Date()
    const db = makeMockDb([
      { id: 'deck-1', title: 'Shared Deck', ownerUserId: 'alice', createdAt: now, updatedAt: now },
    ])
    // Mock: share token grants viewer access
    resolveMock.mockResolvedValueOnce({ role: 'viewer', reason: 'share-link' })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/decks/deck-1?share_token=test-share-token',
    })

    expect(res.statusCode).toBe(200)
  })

  it('returns 403 when no access (no token, no share_token)', async () => {
    const db = makeMockDb([])
    resolveMock.mockResolvedValueOnce(null)
    const app = await buildApp(db, null)

    const res = await app.inject({ method: 'GET', url: '/decks/nonexistent' })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 when deck does not exist but access resolves', async () => {
    const db = makeMockDb([]) // no decks in store
    resolveMock.mockResolvedValueOnce({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/decks/ghost-deck' })
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /decks
// ---------------------------------------------------------------------------

describe('POST /decks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a deck with default title and sets ownerUserId to dev-user (bypass)', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { title: string; ownerUserId: string; id: string }
    expect(body.title).toBe('Untitled Deck')
    // In bypass mode, JWT sub = 'dev-user'
    expect(body.ownerUserId).toBe('dev-user')
    expect(typeof body.id).toBe('string')
  })

  it('creates a deck with custom title', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Q2 Roadmap' }),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { title: string }
    expect(body.title).toBe('Q2 Roadmap')
  })
})

// ---------------------------------------------------------------------------
// DELETE /decks/:id
// ---------------------------------------------------------------------------

describe('DELETE /decks/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 204 when user is owner', async () => {
    const now = new Date()
    const db = makeMockDb([
      {
        id: 'deck-del',
        title: 'To Delete',
        ownerUserId: 'dev-user',
        createdAt: now,
        updatedAt: now,
      },
    ])
    resolveMock.mockResolvedValue({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'DELETE', url: '/decks/deck-del' })
    expect(res.statusCode).toBe(204)
  })

  it('sweeps the deck bucket prefix on successful delete', async () => {
    const now = new Date()
    const db = makeMockDb([
      {
        id: 'deck-purge',
        title: 'To Purge',
        ownerUserId: 'dev-user',
        createdAt: now,
        updatedAt: now,
      },
    ])
    resolveMock.mockResolvedValue({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'DELETE', url: '/decks/deck-purge' })

    expect(res.statusCode).toBe(204)
    expect(purgeMock).toHaveBeenCalledOnce()
    expect(purgeMock).toHaveBeenCalledWith(expect.anything(), 'deck-purge', expect.anything())
    // And once more after the grace window (a transcode still writing its outputs).
    const again = vi.mocked(sweepAgainAfterGrace).mock.calls[0]?.[0]
    expect(again).toBeTypeOf('function')
    await again!()
    expect(purgeMock).toHaveBeenCalledTimes(2)
  })

  it('does not sweep bucket when delete returns 404', async () => {
    const db = makeMockDb([])
    resolveMock.mockResolvedValue({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'DELETE', url: '/decks/missing' })

    expect(res.statusCode).toBe(404)
    expect(purgeMock).not.toHaveBeenCalled()
  })

  it('returns 403 when user is not owner (editor role)', async () => {
    const now = new Date()
    const db = makeMockDb([
      { id: 'deck-1', title: 'Deck', ownerUserId: 'alice', createdAt: now, updatedAt: now },
    ])
    resolveMock.mockResolvedValue({ role: 'editor', reason: 'direct' })
    const app = await buildApp(db, { role: 'editor', reason: 'direct' })

    const res = await app.inject({ method: 'DELETE', url: '/decks/deck-1' })
    expect(res.statusCode).toBe(403)
  })

  it('returns 403 when user has no access', async () => {
    const db = makeMockDb([])
    resolveMock.mockResolvedValue(null)
    const app = await buildApp(db, null)

    const res = await app.inject({ method: 'DELETE', url: '/decks/deck-1' })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for non-existent deck (user is owner but deck is gone)', async () => {
    const db = makeMockDb([]) // empty DB — delete returns []
    resolveMock.mockResolvedValue({ role: 'owner', reason: 'direct' })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'DELETE', url: '/decks/nonexistent' })
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Route registration smoke test
// ---------------------------------------------------------------------------

describe('Route registration', () => {
  it('registers routes without error', async () => {
    const db = makeMockDb()
    expect(() => buildApp(db)).not.toThrow()
  })
})
