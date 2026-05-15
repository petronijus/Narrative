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
