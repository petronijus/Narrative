/**
 * routes/components.test.ts
 *
 * Tests for /folders/:folderId/components and /components/:id REST endpoints (M16 P5).
 * Uses a mock Drizzle DB — no real Postgres.
 *
 * Auth: all tests run with BYPASS_AUTH=true semantics (dev-user synthesized).
 * Access is the caller's role in the folder (folder_permissions — folder
 * sharing, docs/plans/folder-sharing.md): viewers list components, editors
 * create, rename and delete them.
 *
 * Coverage:
 *   GET  /folders/:folderId/components     → any member (a viewer too); 403 outside the folder; 404 on missing folder
 *   POST /folders/:folderId/components     → creates component (server-minted id); optional name; editor needed; 403/404 guards
 *   PATCH /components/:id                  → renames; 400 on empty name; editor needed; 403/404 guards
 *   DELETE /components/:id                 → 204 on success; editor needed; 403/404 guards
 *   PUT /components/:id/thumbnail          → editor needed; 403/404 guards before the body check
 */

import { describe, it, expect, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerComponentRoutes } from './components.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import type { DeckRole } from '../auth/permissions.js'
import { getTableName, type Table } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Mock imgproxyUrl so tests don't need IMGPROXY_KEY/SALT
// ---------------------------------------------------------------------------

vi.mock('../media/imgproxyUrl.js', () => ({
  signImgproxyUrl: vi.fn(({ storageKey }: { storageKey: string }) => `https://img/${storageKey}`),
}))

// Deleting a component purges its storage; no MinIO here.
const purgeComponentBucketPrefix = vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 })
const purgeExplicitKeys = vi.fn().mockResolvedValue({ deleted: 0, errors: 0 })
vi.mock('../media/bucketCleanup.js', () => ({
  purgeComponentBucketPrefix: (...a: unknown[]) => purgeComponentBucketPrefix(...a),
  purgeExplicitKeys: (...a: unknown[]) => purgeExplicitKeys(...a),
  purgeDeckBucketPrefix: vi.fn(),
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

/**
 * A one-folder world, answering each select by the table it reads: the
 * folder, its component, the caller's `folder_permissions` rows (`role`: the
 * dev user's role in the folder, null for none) and no component media.
 */
function makeMockDb(
  opts: {
    folders?: MockFolder[]
    components?: MockComponent[]
    role?: DeckRole | null
  } = {},
) {
  const folderStore: MockFolder[] = opts.folders ? [...opts.folders] : []
  const componentStore: MockComponent[] = opts.components ? [...opts.components] : []
  const role = opts.role === undefined ? 'owner' : opts.role
  let lastInserted: unknown = null
  let lastUpdated: unknown = null
  let deletedId: string | null = null

  const rowsFor = (table: string): unknown[] => {
    if (table === 'folders') return folderStore.slice(0, 1)
    if (table === 'components') return componentStore
    if (table === 'folder_permissions') return role === null ? [] : [{ role }]
    return []
  }

  const db = {
    _lastInserted: () => lastInserted,
    _lastUpdated: () => lastUpdated,
    _deletedId: () => deletedId,
    _componentStore: componentStore,

    select: vi.fn().mockImplementation(() => {
      let table = ''
      const rows = () => Promise.resolve(rowsFor(table))
      const chain = {
        from: vi.fn().mockImplementation((t: Table) => {
          table = getTableName(t)
          return chain
        }),
        where: vi.fn().mockImplementation(() => chain),
        orderBy: vi.fn().mockImplementation(rows),
        limit: vi.fn().mockImplementation(async () => (await rows()).slice(0, 1)),
        // Awaited as is: the folder_permissions rows, a component's media rows.
        then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
          rows().then(onOk, onErr),
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

/** Created by someone else: the dev user's access comes from their folder_permissions row only. */
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

  it("lists a shared folder's components for a viewer of it", async () => {
    const db = makeMockDb({
      folders: [foreignFolder],
      components: [{ ...existingComponent, folderId: 'folder-2' }],
      role: 'viewer',
    })
    const app = await buildApp(db)

    const res = await app.inject({ method: 'GET', url: '/folders/folder-2/components' })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }[]).map((c) => c.id)).toEqual(['comp-1'])
  })

  it('returns 403 for a folder the user is not a member of', async () => {
    const db = makeMockDb({ folders: [foreignFolder], role: null })
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

  it('mints the id itself: a caller-chosen id is ignored', async () => {
    const db = makeMockDb({ folders: [ownerFolder] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'my-custom-id', name: 'Card' }),
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { id: string; name: string }
    expect(body.id).not.toBe('my-custom-id')
    expect(body.id).toMatch(/^[\w-]{12}$/)
    expect(body.name).toBe('Card')
  })

  it('returns 403 for a folder the user is not a member of', async () => {
    const db = makeMockDb({ folders: [foreignFolder], role: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-2/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Test' }),
    })

    expect(res.statusCode).toBe(403)
  })

  it('refuses a viewer of the folder: creating a component needs the editor role', async () => {
    const db = makeMockDb({ folders: [foreignFolder], role: 'viewer' })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-2/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Test' }),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/editor/) })
    expect(db._lastInserted()).toBeNull()
  })

  it('creates a component in a shared folder for an editor of it', async () => {
    const db = makeMockDb({ folders: [foreignFolder], role: 'editor' })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-2/components',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Shared card' }),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ folderId: 'folder-2', name: 'Shared card' })
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

  it('renames it for an editor of the folder, and refuses a viewer', async () => {
    const shared = { ...existingComponent, folderId: 'folder-2' }
    const editorDb = makeMockDb({ folders: [foreignFolder], components: [shared], role: 'editor' })
    const editor = await (
      await buildApp(editorDb)
    ).inject({
      method: 'PATCH',
      url: '/components/comp-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Renamed' }),
    })
    expect(editor.statusCode).toBe(200)

    const viewerDb = makeMockDb({ folders: [foreignFolder], components: [shared], role: 'viewer' })
    const viewer = await (
      await buildApp(viewerDb)
    ).inject({
      method: 'PATCH',
      url: '/components/comp-1',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Renamed' }),
    })
    expect(viewer.statusCode).toBe(403)
    expect(viewer.json()).toMatchObject({ error: expect.stringMatching(/editor/) })
    expect(viewerDb._lastUpdated()).toBeNull()
  })

  it('returns 404 when component does not exist', async () => {
    // Empty stores — the component lookup finds nothing
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
    // Its storage goes too: the components/<id>/ prefix and the tus originals.
    expect(purgeComponentBucketPrefix).toHaveBeenCalledWith('comp-1', expect.anything())
    expect(purgeExplicitKeys).toHaveBeenCalledWith([], expect.anything())
  })

  it('deletes it for an editor of the folder, and refuses a viewer', async () => {
    const shared = { ...existingComponent, folderId: 'folder-2' }
    const viewerDb = makeMockDb({ folders: [foreignFolder], components: [shared], role: 'viewer' })
    const viewer = await (
      await buildApp(viewerDb)
    ).inject({ method: 'DELETE', url: '/components/comp-1' })
    expect(viewer.statusCode).toBe(403)
    expect(viewerDb._deletedId()).toBeNull()

    const editorDb = makeMockDb({ folders: [foreignFolder], components: [shared], role: 'editor' })
    const editor = await (
      await buildApp(editorDb)
    ).inject({ method: 'DELETE', url: '/components/comp-1' })
    expect(editor.statusCode).toBe(204)
    expect(editorDb._deletedId()).toBe('deleted')
  })

  it('returns 404 when component does not exist', async () => {
    // Empty stores — the component lookup finds nothing
    const db = makeMockDb({ folders: [], components: [] })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'DELETE',
      url: '/components/nonexistent',
    })

    expect(res.statusCode).toBe(404)
  })

  it('returns 403 when the component is in a folder the user is not a member of', async () => {
    const foreignComp: MockComponent = {
      ...existingComponent,
      id: 'comp-foreign',
      folderId: 'folder-2',
    }
    const db = makeMockDb({ folders: [foreignFolder], components: [foreignComp], role: null })
    const app = await buildApp(db)

    const res = await app.inject({
      method: 'DELETE',
      url: '/components/comp-foreign',
    })

    expect(res.statusCode).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PUT /components/:id/thumbnail — refusals come from requireComponentRole
// (editor in the component's folder), answered through sendServiceError,
// before the body is even looked at.
// ---------------------------------------------------------------------------

describe('PUT /components/:id/thumbnail', () => {
  const put = async (db: Database) =>
    (await buildApp(db)).inject({
      method: 'PUT',
      url: '/components/comp-1/thumbnail',
      payload: { dataUrl: 'data:image/png;base64,AAAA' },
    })

  it('refuses a viewer of the folder with 403 naming the editor role', async () => {
    const res = await put(
      makeMockDb({ folders: [foreignFolder], components: [existingComponent], role: 'viewer' }),
    )
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Forbidden: this needs the editor role in the folder' })
  })

  it('refuses a user outside the folder with 403', async () => {
    const res = await put(
      makeMockDb({ folders: [foreignFolder], components: [existingComponent], role: null }),
    )
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'Forbidden' })
  })

  it('answers a component that does not exist with 404', async () => {
    const res = await put(makeMockDb({ folders: [], components: [] }))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Component not found' })
  })

  it('lets an editor through to the body check', async () => {
    const db = makeMockDb({
      folders: [foreignFolder],
      components: [existingComponent],
      role: 'editor',
    })
    const res = await (
      await buildApp(db)
    ).inject({
      method: 'PUT',
      url: '/components/comp-1/thumbnail',
      payload: { dataUrl: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'dataUrl is required' })
  })
})
