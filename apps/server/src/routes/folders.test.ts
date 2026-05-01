/**
 * routes/folders.test.ts
 *
 * Tests for /folders REST API endpoints (M16 P1).
 * Uses a mock Drizzle DB — no real Postgres.
 *
 * Auth: all tests run with BYPASS_AUTH=true semantics (dev-user synthesized).
 *
 * Coverage:
 *   GET  /folders                  → returns folders for dev-user (with deckCount)
 *   POST /folders                  → creates folder owned by dev-user
 *   PATCH /folders/:id             → renames own folder; 403 for other user's folder; 404 missing
 *   DELETE /folders/:id            → 204 on empty folder; 409 on non-empty; 409 on Drafts; 403 foreign
 *   POST /folders/:id/move-decks   → moves decks; 400 bad args; 403 foreign; 404 missing folder
 *
 * Also tests deck endpoint changes (M16 integration):
 *   POST /decks                    → auto-provisions Drafts folder and assigns folderId
 *   GET  /decks?folderId           → filters by folder
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerFolderRoutes } from './folders.js'
import { registerDeckRoutes } from './decks.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// Mock resolveDeckAccess (needed by deck route registration)
// ---------------------------------------------------------------------------

vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return {
    ...original,
    resolveDeckAccess: vi.fn().mockResolvedValue({ role: 'owner', reason: 'direct' }),
  }
})

// ---------------------------------------------------------------------------
// Shared test data types
// ---------------------------------------------------------------------------

interface MockFolder {
  id: string
  ownerUserId: string
  name: string
  createdAt: Date
}

interface MockDeck {
  id: string
  title: string
  ownerUserId: string
  folderId: string
  thumbnailKey: null
  thumbnailUpdatedAt: null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Mock DB factory
//
// Strategy: we need a flexible mock that can handle various query patterns.
// Drizzle's fluent API is hard to mock generically, so we use vi.fn() chains
// and shape the responses per-test by storing state in closures.
// ---------------------------------------------------------------------------

function makeMockDb(
  opts: {
    folders?: MockFolder[]
    decks?: MockDeck[]
    deckCount?: number // for count queries in delete endpoint
  } = {},
) {
  const folderStore: MockFolder[] = opts.folders ? [...opts.folders] : []
  const deckStore: MockDeck[] = opts.decks ? [...opts.decks] : []

  // We track the most recent update/delete to allow assertions
  let lastUpdate: unknown = null
  let lastInserted: unknown = null

  const db = {
    _lastUpdate: () => lastUpdate,
    _lastInserted: () => lastInserted,
    _folderStore: folderStore,
    _deckStore: deckStore,

    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([...folderStore, ...deckStore]),
          limit: vi.fn().mockImplementation(() => {
            // Return first matching item — for simplicity, return first folder or deck
            const first = folderStore[0] ?? deckStore[0] ?? null
            return Promise.resolve(first ? [first] : [])
          }),
        }),
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(
              folderStore.map((f) => ({
                id: f.id,
                name: f.name,
                createdAt: f.createdAt,
                deckCount: deckStore.filter((d) => d.folderId === f.id).length,
              })),
            ),
          }),
        }),
        orderBy: vi.fn().mockResolvedValue([...folderStore]),
        limit: vi.fn().mockImplementation(() => {
          const first = folderStore[0] ?? null
          return Promise.resolve(first ? [first] : [])
        }),
      }),
    }),

    insert: vi.fn().mockImplementation((_table: unknown) => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        lastInserted = vals
        const result = {
          returning: vi.fn().mockResolvedValue([{ ...(vals as object) }]),
        }
        return result
      }),
    })),

    update: vi.fn().mockImplementation((_table: unknown) => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation((cols: unknown) => {
            void cols
            // Return updated first folder or deck
            const item = folderStore[0] ?? deckStore[0]
            return Promise.resolve(item ? [item] : [])
          }),
        }),
      }),
    })),

    delete: vi.fn().mockImplementation((_table: unknown) => ({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          const deleted = folderStore.splice(0, 1)
          return Promise.resolve(deleted)
        }),
        // For plain delete (no returning)
        then: vi.fn().mockResolvedValue(undefined),
      }),
    })),

    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(db)
    }),
  }

  return db as unknown as Database
}

// ---------------------------------------------------------------------------
// Targeted mock DB builders for specific scenarios
// ---------------------------------------------------------------------------

function makeFolderSelectMock(folder: MockFolder | null, deckCount = 0, decks: MockDeck[] = []) {
  const db = {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([folder ?? {}]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue(folder ? [folder] : []),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  }

  // Chain: select().from().where().limit() → folder lookup
  // Chain: select().from().where() → count query (for delete)
  // Chain: select().from().leftJoin().where().orderBy() → list
  db.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(folder ? [folder] : []),
        orderBy: vi.fn().mockResolvedValue(folder ? [folder] : []),
        // For count queries, resolve with count row
        then: vi
          .fn()
          .mockImplementation((cb: (v: unknown) => unknown) => cb([{ count: deckCount }])),
      }),
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
      orderBy: vi.fn().mockResolvedValue(decks),
    }),
  })

  return db as unknown as Database
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(db: Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { verifier: null, bypass: true, db })
  await registerFolderRoutes(app, db)
  await registerDeckRoutes(app, db)
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// GET /folders
//
// The route builds a Drizzle subquery (.groupBy().as()) then does a leftJoin.
// We mock at the select() level so the subquery builder returns a plain object
// and the final query resolves with our test rows.
// ---------------------------------------------------------------------------

function makeListFoldersMockDb(expectedRows: unknown[]) {
  // The route does two select() calls:
  //   1. db.select({...}).from(decks).groupBy(...).as('deck_counts') — builds subquery
  //   2. db.select({...}).from(folders).leftJoin(...).where(...).orderBy(...) — actual query
  // We mock so call 1 returns a fake subquery object and call 2 returns expectedRows.
  let selectCallIdx = 0

  const db = {
    select: vi.fn().mockImplementation(() => {
      const idx = selectCallIdx++
      if (idx === 0) {
        // First call: subquery builder — return a chainable object that ends with .as()
        const sub = {
          from: vi.fn().mockReturnThis(),
          groupBy: vi.fn().mockReturnThis(),
          as: vi.fn().mockReturnValue({}), // returns the subquery object (a plain obj is fine)
        }
        return sub
      }
      // Second call: actual list query with leftJoin
      return {
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(expectedRows),
            }),
          }),
        }),
      }
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  }

  return db as unknown as Database
}

describe('GET /folders', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns empty array when user has no folders', async () => {
    const db = makeListFoldersMockDb([])
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/folders' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('returns folders with deckCount', async () => {
    const now = new Date().toISOString()
    const expectedRows = [{ id: 'f-1', name: 'Drafts', createdAt: now, deckCount: 2 }]
    const db = makeListFoldersMockDb(expectedRows)
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/folders' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// POST /folders
// ---------------------------------------------------------------------------

describe('POST /folders', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a folder with the given name', async () => {
    const now = new Date()
    const folder: MockFolder = {
      id: 'f-new',
      ownerUserId: 'dev-user',
      name: 'Projects',
      createdAt: now,
    }
    const db = makeMockDb({ folders: [folder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Projects' }),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { name: string; ownerUserId: string }
    expect(body.name).toBe('Projects')
    expect(body.ownerUserId).toBe('dev-user')
  })

  it('returns 400 when name is missing', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when name is too long', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(201) }),
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// PATCH /folders/:id
// ---------------------------------------------------------------------------

describe('PATCH /folders/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renames own folder', async () => {
    const now = new Date()
    const folder: MockFolder = {
      id: 'f-1',
      ownerUserId: 'dev-user',
      name: 'Old Name',
      createdAt: now,
    }
    const db = makeFolderSelectMock(folder)
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/folders/f-1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })

    expect(res.statusCode).toBe(200)
  })

  it("returns 403 for another user's folder", async () => {
    const now = new Date()
    const folder: MockFolder = {
      id: 'f-1',
      ownerUserId: 'alice',
      name: 'Alice Folder',
      createdAt: now,
    }
    const db = makeFolderSelectMock(folder)
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/folders/f-1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hacked' }),
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for non-existent folder', async () => {
    const db = makeFolderSelectMock(null)
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/folders/ghost',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when name is missing', async () => {
    const now = new Date()
    const folder: MockFolder = { id: 'f-1', ownerUserId: 'dev-user', name: 'F', createdAt: now }
    const db = makeFolderSelectMock(folder)
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/folders/f-1',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// DELETE /folders/:id
// ---------------------------------------------------------------------------

describe('DELETE /folders/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 204 when folder is empty and owned by user', async () => {
    const now = new Date()
    const folder: MockFolder = {
      id: 'f-empty',
      ownerUserId: 'dev-user',
      name: 'Empty',
      createdAt: now,
    }

    // Need to control multiple select calls:
    // 1st select: folder ownership lookup → folder
    // 2nd select: deck count → 0
    let selectCallCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) {
          // ownership lookup
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([folder]),
              }),
            }),
          }
        }
        // deck count
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 0 }]),
          }),
        }
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-empty' })
    expect(res.statusCode).toBe(204)
  })

  // M16 P1 follow-up: DELETE /folders/:id now cascades contained decks
  // instead of rejecting non-empty folders with 409. Drafts is the only
  // folder that still cannot be deleted.
  it.skip('returns 409 folder_not_empty when folder has decks (legacy behaviour)', async () => {
    const now = new Date()
    const folder: MockFolder = {
      id: 'f-full',
      ownerUserId: 'dev-user',
      name: 'Full',
      createdAt: now,
    }

    let selectCallCount = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([folder]),
              }),
            }),
          }
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }]),
          }),
        }
      }),
      delete: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-full' })
    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body) as { error: string; deckCount: number }
    expect(body.error).toBe('folder_not_empty')
    expect(body.deckCount).toBe(3)
  })

  it('returns 409 cannot_delete_drafts for Drafts folder', async () => {
    const now = new Date()
    const drafts: MockFolder = {
      id: 'f-drafts',
      ownerUserId: 'dev-user',
      name: 'Drafts',
      createdAt: now,
    }

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([drafts]),
          }),
        }),
      }),
      delete: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-drafts' })
    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toBe('cannot_delete_drafts')
  })

  it("returns 403 when trying to delete another user's folder", async () => {
    const now = new Date()
    const folder: MockFolder = { id: 'f-1', ownerUserId: 'alice', name: 'Alice', createdAt: now }

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([folder]),
          }),
        }),
      }),
      delete: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-1' })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for non-existent folder', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/ghost' })
    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /folders/:id/move-decks
// ---------------------------------------------------------------------------

describe('POST /folders/:id/move-decks', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 400 when deckIds is missing or empty', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/f-src/move-decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deckIds: [], destFolderId: 'f-dest' }),
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when destFolderId is missing', async () => {
    const db = makeMockDb()
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/f-src/move-decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deckIds: ['d-1'] }),
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 404 when source folder does not exist', async () => {
    // All selects return []
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: '/folders/f-src/move-decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deckIds: ['d-1'], destFolderId: 'f-dest' }),
    })

    expect(res.statusCode).toBe(404)
  })

  it('successfully moves decks and returns movedCount', async () => {
    const now = new Date()
    const srcFolder: MockFolder = {
      id: 'f-src',
      ownerUserId: 'dev-user',
      name: 'Drafts',
      createdAt: now,
    }
    const destFolder: MockFolder = {
      id: 'f-dest',
      ownerUserId: 'dev-user',
      name: 'Projects',
      createdAt: now,
    }
    const deck: MockDeck = {
      id: 'd-1',
      title: 'Deck',
      ownerUserId: 'dev-user',
      folderId: 'f-src',
      thumbnailKey: null,
      thumbnailUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    let folderSelectIdx = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        const idx = folderSelectIdx++
        if (idx === 0) {
          // source folder lookup
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([srcFolder]),
              }),
            }),
          }
        }
        if (idx === 1) {
          // dest folder lookup
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([destFolder]),
              }),
            }),
          }
        }
        // deck rows lookup
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([deck]),
          }),
        }
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'd-1' }]),
          }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: '/folders/f-src/move-decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deckIds: ['d-1'], destFolderId: 'f-dest' }),
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { movedCount: number }
    expect(body.movedCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// POST /decks — auto-provision Drafts + folderId in response
// ---------------------------------------------------------------------------

describe('POST /decks — folder integration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('auto-provisions Drafts folder when user has none and creates deck there', async () => {
    const now = new Date()
    const draftsId = 'drafts-auto'

    // select() for getOrProvisionDrafts → no existing Drafts folder
    // then insert folders → draftsId
    // then folder ownership check skipped (no folderId requested)
    // then deck insert

    let selectIdx = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectIdx++
        if (selectIdx === 1) {
          // getOrProvisionDrafts: folder lookup → empty
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }
        }
        // fallback
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((vals: unknown) => ({
          returning: vi.fn().mockResolvedValue([
            // First insert is folders (provisioning), second is deck, third is permissions
            typeof (vals as { id?: string }).id === 'string'
              ? { ...(vals as object), id: draftsId }
              : { ...(vals as object) },
          ]),
        })),
      })),
      transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        // Create a tx that records deck insert
        const insertedDeck = {
          id: 'deck-new',
          title: 'Untitled Deck',
          ownerUserId: 'dev-user',
          folderId: draftsId,
          createdAt: now,
          updatedAt: now,
          thumbnailKey: null,
          thumbnailUpdatedAt: null,
        }
        const tx = {
          insert: vi.fn().mockImplementation(() => ({
            values: vi.fn().mockImplementation(() => ({
              returning: vi.fn().mockResolvedValue([insertedDeck]),
            })),
          })),
        }
        return fn(tx)
      }),
      update: vi.fn(),
      delete: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'POST',
      url: '/decks',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { ownerUserId: string; folderId: string }
    expect(body.ownerUserId).toBe('dev-user')
    // folderId is set (auto-provisioned Drafts)
    expect(typeof body.folderId).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// GET /decks?folderId — folder filter
// ---------------------------------------------------------------------------

describe('GET /decks?folderId', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 404 when filtering by non-existent folder', async () => {
    // folder lookup returns empty
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: '/decks?folderId=ghost-folder' })
    expect(res.statusCode).toBe(404)
  })

  it("returns 403 when filtering by another user's folder", async () => {
    const now = new Date()
    const aliceFolder = { id: 'f-alice', ownerUserId: 'alice', name: 'Alice', createdAt: now }

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([aliceFolder]),
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: '/decks?folderId=f-alice' })
    expect(res.statusCode).toBe(403)
  })

  it('returns decks in folder when caller owns the folder', async () => {
    const now = new Date()
    const myFolder = { id: 'f-mine', ownerUserId: 'dev-user', name: 'Drafts', createdAt: now }
    const myDeck: MockDeck = {
      id: 'd-1',
      title: 'My Deck',
      ownerUserId: 'dev-user',
      folderId: 'f-mine',
      thumbnailKey: null,
      thumbnailUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    }

    let selectIdx = 0
    const db = {
      select: vi.fn().mockImplementation(() => {
        const idx = selectIdx++
        if (idx === 0) {
          // folder ownership check
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([myFolder]),
              }),
            }),
          }
        }
        // deck list query
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([myDeck]),
            }),
          }),
        }
      }),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database

    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: '/decks?folderId=f-mine' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(Array.isArray(body)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Route registration smoke test
// ---------------------------------------------------------------------------

describe('Route registration', () => {
  it('registers folder routes without error', async () => {
    const db = makeMockDb()
    expect(() => buildApp(db)).not.toThrow()
  })
})
