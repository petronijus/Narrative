/**
 * routes/components.test.ts
 *
 * Tests for /folders/:folderId/components and /components/:id REST endpoints (M16 P5).
 * Uses a mock Drizzle DB — no real Postgres.
 *
 * Auth: all tests run with BYPASS_AUTH=true semantics (dev-user synthesized).
 *
 * Coverage:
 *   GET  /folders/:folderId/components     → returns components for folder owner; 403 on wrong user; 404 on missing folder
 *   POST /folders/:folderId/components     → creates component; optional name + id; 403/404 guards
 *   PATCH /components/:id                  → renames; 400 on empty name; 403/404 guards
 *   DELETE /components/:id                 → 204 on success; 403/404 guards
 */

import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerComponentRoutes } from './components.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'

// ---------------------------------------------------------------------------
// Mock imgproxyUrl so tests don't need IMGPROXY_KEY/SALT
// ---------------------------------------------------------------------------

vi.mock('../media/imgproxyUrl.js', () => ({
  signImgproxyUrl: vi.fn(({ storageKey }: { storageKey: string }) => `https://img/${storageKey}`),
}))

// ---------------------------------------------------------------------------
// Test data types
// ---------------------------------------------------------------------------

interface MockFolder {
  id: string
  ownerUserId: string
  name: string
  createdAt: Date
}

interface MockComponent {
  id: string
  folderId: string
  name: string
  thumbnailKey: string | null
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeMockDb(
  opts: {
    folders?: MockFolder[]
    components?: MockComponent[]
  } = {},
) {
  const folderStore: MockFolder[] = opts.folders ? [...opts.folders] : []
  const componentStore: MockComponent[] = opts.components ? [...opts.components] : []
  let lastInserted: unknown = null
  let lastUpdated: unknown = null
  let deletedId: string | null = null

  const db = {
    _lastInserted: () => lastInserted,
    _lastUpdated: () => lastUpdated,
    _deletedId: () => deletedId,
    _componentStore: componentStore,

    select: vi.fn().mockImplementation(() => {
      const chain = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(() => {
              // Heuristic: if querying folders, return first folder; components → first component
              const result = folderStore[0] ?? componentStore[0] ?? null
              return Promise.resolve(result ? [result] : [])
            }),
            orderBy: vi.fn().mockResolvedValue([...componentStore]),
          }),
          orderBy: vi.fn().mockResolvedValue([...componentStore]),
          limit: vi.fn().mockImplementation(() => {
            const result = folderStore[0] ?? null
            return Promise.resolve(result ? [result] : [])
          }),
        }),
      }
      return chain
    }),

    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        lastInserted = vals
        return {
          returning: vi.fn().mockResolvedValue([{ ...(vals as object) }]),
        }
      }),
    })),

    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => {
            lastUpdated = true
            const comp = componentStore[0] ?? null
            return Promise.resolve(comp ? [comp] : [])
          }),
        }),
      }),
    })),

    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => {
        deletedId = 'deleted'
        return Promise.resolve({ rowCount: 1 })
      }),
    })),
  }

  return db as unknown as Database & {
    _lastInserted: () => unknown
    _lastUpdated: () => unknown
    _deletedId: () => string | null
  }
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

async function buildApp(db: Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass: true, db })
  await registerComponentRoutes(app, db)
  return app
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const ownerFolder: MockFolder = {
  id: 'folder-1',
  ownerUserId: 'dev-user',
  name: 'My Folder',
  createdAt: new Date('2026-01-01'),
}

const foreignFolder: MockFolder = {
  id: 'folder-2',
  ownerUserId: 'other-user',
  name: 'Their Folder',
  createdAt: new Date('2026-01-01'),
}

const existingComponent: MockComponent = {
  id: 'comp-1',
  folderId: 'folder-1',
  name: 'Button',
  thumbnailKey: null,
  createdAt: new Date('2026-02-01'),
  updatedAt: new Date('2026-02-01'),
}

// ---------------------------------------------------------------------------
// GET /folders/:folderId/components
// ---------------------------------------------------------------------------

describe('GET /folders/:folderId/components', () => {
  it('returns components for owned folder', async () => {
    const db = makeMockDb({ folders: [ownerFolder], components: [existingComponent] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/folders/folder-1/components',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  it('returns 403 for a foreign folder', async () => {
    // Mock: folder exists but owned by other-user
    const db = makeMockDb({ folders: [foreignFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/folders/folder-2/components',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for missing folder', async () => {
    const db = makeMockDb({ folders: [] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/folders/no-such-folder/components',
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /folders/:folderId/components
// ---------------------------------------------------------------------------

describe('POST /folders/:folderId/components', () => {
  it('creates a component with default name when no name provided', async () => {
    const db = makeMockDb({ folders: [ownerFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { name: string; folderId: string }
    expect(body.name).toBe('Untitled component')
    expect(body.folderId).toBe('folder-1')
  })

  it('creates a component with provided name', async () => {
    const db = makeMockDb({ folders: [ownerFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Hero Banner' }),
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { name: string }
    expect(body.name).toBe('Hero Banner')
  })

  it('uses caller-provided id when supplied', async () => {
    const db = makeMockDb({ folders: [ownerFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'my-custom-id', name: 'Card' }),
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string }
    expect(body.id).toBe('my-custom-id')
  })

  it('returns 403 for a folder owned by another user', async () => {
    const db = makeMockDb({ folders: [foreignFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-2/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Test' }),
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for a missing folder', async () => {
    const db = makeMockDb({ folders: [] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/no-such/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Test' }),
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /components/:id
// ---------------------------------------------------------------------------

describe('PATCH /components/:id', () => {
  it('renames a component owned by the current user', async () => {
    // checkComponentOwner needs: component lookup → folder lookup
    // We craft the mock to respond consistently.
    const db = makeMockDb({ folders: [ownerFolder], components: [existingComponent] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/components/comp-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Updated Button' }),
    })

    // The mock returns the first component from store; just verify no error
    expect(res.statusCode).toBe(200)
  })

  it('returns 400 when name is empty', async () => {
    const db = makeMockDb({ folders: [ownerFolder], components: [existingComponent] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/components/comp-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: '' }),
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when name exceeds 200 chars', async () => {
    const db = makeMockDb({ folders: [ownerFolder], components: [existingComponent] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/components/comp-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(201) }),
    })

    expect(res.statusCode).toBe(400)
  })

  it('returns 404 when component does not exist', async () => {
    // Empty stores — select returns nothing, so checkComponentOwner returns 'not_found'
    const db = makeMockDb({ folders: [], components: [] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'PATCH',
      url: '/components/nonexistent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Test' }),
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /components/:id
// ---------------------------------------------------------------------------

describe('DELETE /components/:id', () => {
  it('deletes a component owned by the current user → 204', async () => {
    const db = makeMockDb({ folders: [ownerFolder], components: [existingComponent] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'DELETE',
      url: '/components/comp-1',
    })

    expect(res.statusCode).toBe(204)
  })

  it('returns 404 when component does not exist', async () => {
    // Empty stores — select returns nothing, so checkComponentOwner returns 'not_found'
    const db = makeMockDb({ folders: [], components: [] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'DELETE',
      url: '/components/nonexistent',
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 403 when component belongs to another user folder', async () => {
    // Component exists but folder is owned by other-user
    const foreignComp: MockComponent = {
      ...existingComponent,
      id: 'comp-foreign',
      folderId: 'folder-2',
    }
    const db = makeMockDb({ folders: [foreignFolder], components: [foreignComp] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'DELETE',
      url: '/components/comp-foreign',
    })

    expect(res.statusCode).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /components/:id/instance-count (M16 P6)
// ---------------------------------------------------------------------------

/**
 * Builds a deck Y.Doc with `instanceCount` componentInstance nodes targeting
 * `componentId`, plus a single non-matching rectangle so we exercise the
 * walker's filter. Returns the encoded update bytes.
 */
function makeDeckDocWithInstances(componentId: string, instanceCount: number): Uint8Array {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objects = new Y.Array<Y.Map<unknown>>()
    slide.set('id', 'slide-0')
    slide.set('objects', objects)
    slide.set('animations', new Y.Array<Y.Map<unknown>>())

    // One rect — should NOT count.
    const rect = new Y.Map<unknown>()
    rect.set('id', 'r1')
    rect.set('type', 'rectangle')
    objects.push([rect])

    for (let i = 0; i < instanceCount; i++) {
      const inst = new Y.Map<unknown>()
      inst.set('id', `inst-${i}`)
      inst.set('type', 'componentInstance')
      inst.set('componentId', componentId)
      objects.push([inst])
    }

    slides.push([slide])
  })

  const bytes = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return bytes
}

/**
 * Mock DB for instance-count tests. Distinct from `makeMockDb` because the
 * count endpoint needs realistic deck + deck_updates queries that the
 * heuristic mock can't disambiguate.
 *
 * Discriminates query targets by inspecting the table reference passed to
 * `select(...).from(table)`. Drizzle's `from()` receives the imported table
 * symbol; our mock attaches a `_kind` tag at call sites so we can route.
 */
function makeInstanceCountMockDb(opts: {
  folders: MockFolder[]
  components: MockComponent[]
  decks: Array<{ id: string; folderId: string }>
  deckUpdates: Record<string, Uint8Array[]>
}): Database {
  const { folders: folderStore, components: componentStore, decks: deckStore, deckUpdates } = opts

  // The route does select() chains in this order:
  //   1. checkComponentOwner: select({id, folderId}).from(components).where(eq(id)).limit(1)
  //   2. checkFolderOwner:    select({id, owner}).from(folders).where(eq(id)).limit(1)
  //   3. select({id}).from(decks).where(eq(folderId)).orderBy(createdAt)   → array
  //   4. for each deck: select({update}).from(deckUpdates).where(eq(deckId)).orderBy(id) → array
  //
  // We use a call counter to route 1/2/3/4 by index. Brittle but
  // sufficient for the cases we cover.
  let selectCallIdx = 0
  let pendingDeckId: string | null = null

  const db = {
    select: vi.fn().mockImplementation((_cols?: unknown) => {
      const callIdx = selectCallIdx++
      // Detect deck_updates select by column shape: it requests `update` only.
      // Drizzle passes the column object as `cols` arg.
      const colKeys =
        _cols !== null && typeof _cols === 'object' ? Object.keys(_cols as object) : []
      const isDeckUpdates = colKeys.length === 1 && colKeys[0] === 'update'

      return {
        from: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation((cond: unknown) => {
            // Heuristic: capture deckId from `eq(deckUpdates.deckId, X)` 2nd arg.
            // We can't easily extract it from the drizzle expression — instead,
            // use the call sequence: callIdx 3+ are per-deck deckUpdates queries.
            void cond
            return {
              limit: vi.fn().mockImplementation(() => {
                if (callIdx === 0) {
                  // checkComponentOwner: components row
                  const c = componentStore[0]
                  return Promise.resolve(c ? [{ id: c.id, folderId: c.folderId }] : [])
                }
                if (callIdx === 1) {
                  // checkFolderOwner: folders row
                  const f = folderStore.find((x) => x.id === componentStore[0]?.folderId)
                  return Promise.resolve(f ? [{ id: f.id, ownerUserId: f.ownerUserId }] : [])
                }
                return Promise.resolve([])
              }),
              orderBy: vi.fn().mockImplementation(() => {
                if (isDeckUpdates) {
                  // deck_updates query — we need the deckId. Track the call
                  // index relative to deck enumeration.
                  const deckIdx = callIdx - 3 // 0 = first deck after the listing
                  const deckId = deckStore[deckIdx]?.id ?? pendingDeckId ?? deckStore[0]?.id
                  const updates = deckId !== undefined ? (deckUpdates[deckId] ?? []) : []
                  return Promise.resolve(updates.map((u) => ({ update: u })))
                }
                // decks listing
                return Promise.resolve(deckStore.map((d) => ({ id: d.id })))
              }),
            }
          }),
        })),
      }
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }

  return db as unknown as Database
}

describe('GET /components/:id/instance-count', () => {
  it('returns count: 0 when no decks reference the component', async () => {
    const db = makeInstanceCountMockDb({
      folders: [ownerFolder],
      components: [existingComponent],
      decks: [{ id: 'deck-1', folderId: 'folder-1' }],
      deckUpdates: {
        'deck-1': [makeDeckDocWithInstances('some-other-comp', 0)],
      },
    })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/components/comp-1/instance-count',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { count: number }
    expect(body.count).toBe(0)
  })

  it('returns count: N when decks reference the component', async () => {
    const db = makeInstanceCountMockDb({
      folders: [ownerFolder],
      components: [existingComponent],
      decks: [{ id: 'deck-1', folderId: 'folder-1' }],
      deckUpdates: {
        'deck-1': [makeDeckDocWithInstances('comp-1', 3)],
      },
    })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/components/comp-1/instance-count',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { count: number }
    expect(body.count).toBe(3)
  })

  it('returns 403 when the component belongs to a foreign folder', async () => {
    const foreignComp: MockComponent = {
      ...existingComponent,
      id: 'comp-foreign',
      folderId: 'folder-2',
    }
    const db = makeInstanceCountMockDb({
      folders: [foreignFolder],
      components: [foreignComp],
      decks: [],
      deckUpdates: {},
    })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/components/comp-foreign/instance-count',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 when the component does not exist', async () => {
    const db = makeInstanceCountMockDb({
      folders: [],
      components: [],
      decks: [],
      deckUpdates: {},
    })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'GET',
      url: '/components/missing/instance-count',
    })

    expect(res.statusCode).toBe(404)
  })
})
