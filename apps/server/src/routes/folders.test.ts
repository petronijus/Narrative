/**
 * routes/folders.test.ts
 *
 * Tests for /folders REST API endpoints (M16 P1).
 * Uses a mock Drizzle DB — no real Postgres.
 *
 * Auth: all tests run with BYPASS_AUTH=true semantics (dev-user synthesized).
 *
 * Access is the caller's role in the folder (folder_permissions — folder
 * sharing, docs/plans/folder-sharing.md); the scripted database
 * (test-support/scriptedDb.ts) answers a service's selects in order, so a
 * folder check is two answers: the folder row, then the caller's
 * folder_permissions rows.
 *
 * Coverage:
 *   GET  /folders                  → the caller's folders with deckCount and their role
 *   POST /folders                  → creates folder owned by dev-user, its owner row with it
 *   PATCH /folders/:id             → renames (owner only); 403 non-member / editor; 404 missing
 *   DELETE /folders/:id            → 200 {deletedDeckCount} (cascades decks); owner only; 409 on Drafts
 *   POST /folders/:id/move-decks   → moves decks (editor in both folders, owner of each deck); 400 bad args; 404 missing folder
 *
 * Also tests deck endpoint changes (M16 integration):
 *   POST /decks                    → auto-provisions Drafts folder and assigns folderId
 *   GET  /decks?folderId           → filters by folder
 */

import * as Y from 'yjs'
import { DEFAULT_COLORS, DEFAULT_TEXT_STYLES, readFolderTokens } from '@narrative/slide-model'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerFolderRoutes } from './folders.js'
import { registerDeckRoutes } from './decks.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import { resolveDeckAccess } from '../auth/permissions.js'
import { scriptedDb } from '../test-support/scriptedDb.js'

// ---------------------------------------------------------------------------
// Mock resolveDeckAccess (needed by deck route registration)
// ---------------------------------------------------------------------------

// Moving a deck copies the media it links from its old folder
// (services/localiseMedia.ts, its own tests against Postgres); here only
// that the move asks for it, before and after.
vi.mock('../services/localiseMedia.js', () => ({
  localiseLinkedMedia: vi.fn().mockResolvedValue({ copied: 0, unresolved: 0 }),
}))

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
// App builder
// ---------------------------------------------------------------------------

async function buildApp(db: Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: true, db })
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

describe('GET /folders', () => {
  beforeEach(() => vi.clearAllMocks())

  // The list is one query (its subqueries are built, never awaited alone).
  it('returns empty array when user has no folders', async () => {
    const { db } = scriptedDb({ selects: [[]] })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/folders' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it("returns folders with deckCount and the caller's role in each", async () => {
    const now = new Date()
    const { db } = scriptedDb({
      selects: [
        [
          { id: 'f-1', name: 'Drafts', createdAt: now, deckCount: 2, role: 'owner' },
          { id: 'f-2', name: 'Shared with me', createdAt: now, deckCount: 5, role: 'viewer' },
        ],
      ],
    })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/folders' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { id: 'f-1', name: 'Drafts', createdAt: now.toISOString(), deckCount: 2, role: 'owner' },
      {
        id: 'f-2',
        name: 'Shared with me',
        createdAt: now.toISOString(),
        deckCount: 5,
        role: 'viewer',
      },
    ])
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
    const body = JSON.parse(res.body) as { id: string; name: string; ownerUserId: string }
    expect(body.name).toBe('Projects')
    expect(body.ownerUserId).toBe('dev-user')
    expect(body).toMatchObject({ role: 'owner', deckCount: 0 })

    // A2.12: the new folder's document got the default tokens (written as a
    // delta row: no sync server runs in this test).
    const seed = (db as unknown as { _lastInserted: () => unknown })._lastInserted() as {
      folderId: string
      update: Uint8Array
    }
    expect(seed.folderId).toBe(body.id)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, seed.update)
    const tokens = readFolderTokens(doc)
    expect(Object.values(tokens.textStyles).map((t) => t.name)).toEqual(
      expect.arrayContaining(DEFAULT_TEXT_STYLES.map((t) => t.name)),
    )
    expect(Object.keys(tokens.colors)).toHaveLength(DEFAULT_COLORS.length)
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

  const folder: MockFolder = {
    id: 'f-1',
    ownerUserId: 'alice',
    name: 'Old Name',
    createdAt: new Date(),
  }
  const rename = (db: Database, body: unknown = { name: 'New Name' }) =>
    buildApp(db).then((app) =>
      app.inject({
        method: 'PATCH',
        url: '/folders/f-1',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('renames a folder for its owner', async () => {
    const scripted = scriptedDb({
      selects: [[folder], [{ role: 'owner' }]],
      updates: [[{ ...folder, name: 'New Name' }]],
    })

    const res = await rename(scripted.db)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: 'f-1', name: 'New Name' })
    expect(scripted.writes).toEqual([
      { kind: 'update', table: 'folders', values: { name: 'New Name' } },
    ])
  })

  it("refuses an editor of the folder: renaming is the owner's", async () => {
    const scripted = scriptedDb({ selects: [[folder], [{ role: 'editor' }]] })

    const res = await rename(scripted.db, { name: 'Hacked' })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/owner/) })
    expect(scripted.writes).toEqual([])
  })

  it('returns 403 for a folder the user is not a member of', async () => {
    const scripted = scriptedDb({ selects: [[folder], []] })

    const res = await rename(scripted.db, { name: 'Hacked' })

    expect(res.statusCode).toBe(403)
    expect(scripted.writes).toEqual([])
  })

  it('returns 404 for non-existent folder', async () => {
    const { db } = scriptedDb({ selects: [[]] })
    const res = await rename(db)
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when name is missing', async () => {
    const { db } = scriptedDb({ selects: [[folder], [{ role: 'owner' }]] })
    const res = await rename(db, {})
    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// DELETE /folders/:id
// ---------------------------------------------------------------------------

describe('DELETE /folders/:id', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 200 with deletedDeckCount when folder is empty and owned by user', async () => {
    const folder: MockFolder = {
      id: 'f-empty',
      ownerUserId: 'dev-user',
      name: 'Empty',
      createdAt: new Date(),
    }
    // The folder and the owner's row; no decks, components or media in it.
    const scripted = scriptedDb({ selects: [[folder], [{ role: 'owner' }], [], [], []] })

    const app = await buildApp(scripted.db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-empty' })
    // 200 (not 204): a 204 must not carry a body, so the count is returned with 200.
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ deletedDeckCount: 0 })
    expect(scripted.writes).toEqual([{ kind: 'delete', table: 'folders' }])
  })

  it("refuses an editor of the folder: deleting it is the owner's", async () => {
    const folder: MockFolder = {
      id: 'f-1',
      ownerUserId: 'alice',
      name: 'Team',
      createdAt: new Date(),
    }
    const scripted = scriptedDb({ selects: [[folder], [{ role: 'editor' }]] })

    const app = await buildApp(scripted.db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-1' })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/owner/) })
    expect(scripted.writes).toEqual([])
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
    const drafts: MockFolder = {
      id: 'f-drafts',
      ownerUserId: 'dev-user',
      name: 'Drafts',
      createdAt: new Date(),
    }
    const scripted = scriptedDb({ selects: [[drafts], [{ role: 'owner' }]] })

    const app = await buildApp(scripted.db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-drafts' })
    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body) as { error: string }
    expect(body.error).toBe('cannot_delete_drafts')
    expect(scripted.writes).toEqual([])
  })

  it('returns 403 when trying to delete a folder the user is not a member of', async () => {
    const folder: MockFolder = {
      id: 'f-1',
      ownerUserId: 'alice',
      name: 'Alice',
      createdAt: new Date(),
    }
    const scripted = scriptedDb({ selects: [[folder], []] })

    const app = await buildApp(scripted.db)
    const res = await app.inject({ method: 'DELETE', url: '/folders/f-1' })
    expect(res.statusCode).toBe(403)
    expect(scripted.writes).toEqual([])
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

  const moveFolders = {
    src: { id: 'f-src', ownerUserId: 'alice', name: 'Team', createdAt: new Date() },
    dest: { id: 'f-dest', ownerUserId: 'alice', name: 'Archive', createdAt: new Date() },
  }
  const move = (db: Database) =>
    buildApp(db).then((app) =>
      app.inject({
        method: 'POST',
        url: '/folders/f-src/move-decks',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deckIds: ['d-1'], destFolderId: 'f-dest' }),
      }),
    )

  it('moves decks for an editor of both folders who owns the deck, and returns movedCount', async () => {
    const scripted = scriptedDb({
      selects: [
        [moveFolders.src],
        [{ role: 'editor' }],
        [moveFolders.dest],
        [{ role: 'editor' }],
        [{ id: 'd-1', folderId: 'f-src' }],
        // The caller's owner grants on the moved decks.
        [{ deckId: 'd-1' }],
      ],
      updates: [[{ id: 'd-1' }]],
    })

    const res = await move(scripted.db)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { movedCount: number }
    expect(body.movedCount).toBe(1)
    expect(resolveDeckAccess).not.toHaveBeenCalled()
    expect(scripted.writes[0]).toMatchObject({
      kind: 'update',
      table: 'decks',
      values: { folderId: 'f-dest' },
    })
  })

  it('refuses a viewer of the destination folder: a deck may not be moved into it', async () => {
    const scripted = scriptedDb({
      selects: [[moveFolders.src], [{ role: 'owner' }], [moveFolders.dest], [{ role: 'viewer' }]],
    })

    const res = await move(scripted.db)

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/editor/) })
    expect(scripted.writes).toEqual([])
  })

  it('refuses a viewer of the source folder', async () => {
    const scripted = scriptedDb({ selects: [[moveFolders.src], [{ role: 'viewer' }]] })

    const res = await move(scripted.db)

    expect(res.statusCode).toBe(403)
    expect(scripted.writes).toEqual([])
  })

  it('refuses an editor of both folders who is only an editor of the deck: moving changes who sees it', async () => {
    const scripted = scriptedDb({
      selects: [
        [moveFolders.src],
        [{ role: 'editor' }],
        [moveFolders.dest],
        [{ role: 'editor' }],
        [{ id: 'd-1', folderId: 'f-src' }],
        // No owner grant on d-1.
        [],
      ],
    })

    const res = await move(scripted.db)

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/owner role/) })
    expect(scripted.writes).toEqual([])
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

  it('returns 403 when filtering by a folder the user is not a member of', async () => {
    const aliceFolder = {
      id: 'f-alice',
      ownerUserId: 'alice',
      name: 'Alice',
      createdAt: new Date(),
    }
    const { db } = scriptedDb({ selects: [[aliceFolder], []] })

    const app = await buildApp(db)
    const res = await app.inject({ method: 'GET', url: '/decks?folderId=f-alice' })
    expect(res.statusCode).toBe(403)
  })

  it('returns decks in folder when the caller is a member, a viewer included', async () => {
    const now = new Date()
    const sharedFolder = { id: 'f-shared', ownerUserId: 'alice', name: 'Team', createdAt: now }
    const deck: MockDeck = {
      id: 'd-1',
      title: 'Their Deck',
      ownerUserId: 'dev-user',
      folderId: 'f-shared',
      thumbnailKey: null,
      thumbnailUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    const scripted = scriptedDb({ selects: [[sharedFolder], [{ role: 'viewer' }], [deck]] })

    const app = await buildApp(scripted.db)
    const res = await app.inject({ method: 'GET', url: '/decks?folderId=f-shared' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }[]).map((d) => d.id)).toEqual(['d-1'])
    expect(scripted.remaining().selects).toBe(0)
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
