/**
 * routes/tokens.test.ts
 *
 * GET /folders/:folderId/tokens/:category/:tokenId/usages (M16 P4), and the
 * token writes POST / PATCH / DELETE (A2.12) — validated with the commands'
 * input schemas, written as a delta row when no sync server runs in the
 * process (services/liveDocs.ts; the live path is services/tokens.test.ts).
 *
 * Usage tests:
 *   - empty folder → 200 { usages: [] }
 *   - deck with a matching token ref on an object → 200 with deck entry
 *   - deck with no matching refs → 200 { usages: [] }
 *   - component with a matching token ref → 200 with component entry
 *   - textStyle in folder doc referencing a color token → 200 with textStyle entry
 *   - wrong owner → 403
 *   - missing folder → 404
 *
 * Uses real Y.Doc to produce update bytes so the scanner logic is exercised
 * end-to-end, but the DB is mocked (no real Postgres).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Session cookies `s-<user>-<n>` resolve to <user> (the origin guard test).
vi.mock('../auth/session.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/session.js')>()
  return {
    ...original,
    lookupSession: vi.fn(async (_db: unknown, raw: string) => {
      const m = /^s-([a-z-]+)-\d+$/.exec(raw)
      return m ? { userSub: m[1]!, userEmail: `${m[1]}@example.com`, userName: null } : null
    }),
  }
})
import Fastify, { type FastifyInstance } from 'fastify'
import * as Y from 'yjs'
import { registerTokenRoutes } from './tokens.js'
import { registerAuthPlugin } from '../auth/fastifyAuth.js'
import type { Database } from '../db/client.js'
import { addFolderToken, readFolderTokens } from '@narrative/slide-model'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { registerSameOriginPolicy } from '../http/sameOrigin.js'

const SPA = 'http://localhost:5173'

// ---------------------------------------------------------------------------
// Y.Doc helpers — build minimal docs and encode as updates
// ---------------------------------------------------------------------------

/**
 * Builds a deck Y.Doc where slide 0 has one rectangle object whose `fill`
 * is a TokenRef pointing at tokenKey.
 */
function makeDeckDocWithTokenRef(tokenKey: string): Uint8Array {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objects = new Y.Array<Y.Map<unknown>>()
    const animations = new Y.Array<Y.Map<unknown>>()
    slide.set('id', 'slide-0')
    slide.set('objects', objects)
    slide.set('animations', animations)

    const obj = new Y.Map<unknown>()
    obj.set('id', 'obj-1')
    obj.set('type', 'rectangle')
    obj.set('fill', { $token: tokenKey })
    objects.push([obj])

    slides.push([slide])
  })

  return Y.encodeStateAsUpdate(doc)
}

/**
 * Builds a deck Y.Doc with no token refs.
 */
function makeDeckDocWithNoRefs(): Uint8Array {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objects = new Y.Array<Y.Map<unknown>>()
    slide.set('id', 'slide-0')
    slide.set('objects', objects)
    slide.set('animations', new Y.Array())

    const obj = new Y.Map<unknown>()
    obj.set('id', 'obj-2')
    obj.set('type', 'rectangle')
    obj.set('fill', 0xff0000)
    objects.push([obj])

    slides.push([slide])
  })

  return Y.encodeStateAsUpdate(doc)
}

/**
 * Builds a component Y.Doc (same schema as deck) with one object whose
 * `stroke` is a TokenRef.
 */
function makeComponentDocWithTokenRef(tokenKey: string): Uint8Array {
  const doc = new Y.Doc()
  const slides = doc.getArray<Y.Map<unknown>>('slides')

  doc.transact(() => {
    const slide = new Y.Map<unknown>()
    const objects = new Y.Array<Y.Map<unknown>>()
    slide.set('id', 'slide-0')
    slide.set('objects', objects)
    slide.set('animations', new Y.Array())

    const obj = new Y.Map<unknown>()
    obj.set('id', 'comp-obj-1')
    obj.set('type', 'ellipse')
    obj.set('fill', 0x0000ff)
    obj.set('stroke', { $token: tokenKey })
    objects.push([obj])

    slides.push([slide])
  })

  return Y.encodeStateAsUpdate(doc)
}

/**
 * Builds a folder Y.Doc where a textStyle's `color` is a TokenRef pointing
 * at the given color token key.
 */
function makeFolderDocWithTextStyleRef(tokenKey: string): Uint8Array {
  const doc = new Y.Doc()
  const tokensMap = doc.getMap<unknown>('tokens')

  doc.transact(() => {
    const textStylesMap = new Y.Map<Y.Map<unknown>>()
    const style = new Y.Map<unknown>()
    style.set('id', 'style-1')
    style.set('name', 'Heading')
    style.set('color', { $token: tokenKey })
    textStylesMap.set('style-1', style)
    tokensMap.set('textStyles', textStylesMap as unknown)
  })

  return Y.encodeStateAsUpdate(doc)
}

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

interface FolderRow {
  id: string
  ownerUserId: string
  name: string
  createdAt: Date
}

interface DeckRow {
  id: string
  title: string
  folderId: string
  createdAt: Date
}

interface ComponentRow {
  id: string
  folderId: string
  name: string
  createdAt: Date
}

interface UpdateRow {
  update: Uint8Array
}

interface MockDbOpts {
  folders?: FolderRow[]
  decks?: DeckRow[]
  components?: ComponentRow[]
  deckUpdates?: Record<string, UpdateRow[]>
  folderUpdates?: Record<string, UpdateRow[]>
  componentUpdates?: Record<string, UpdateRow[]>
}

/**
 * Creates a mock Drizzle DB that handles the specific query patterns used by
 * the tokenUsages route.  Uses a call-tracking approach based on what table
 * `from()` receives.
 */
function makeMockDb(opts: MockDbOpts = {}): Database {
  const folderStore: FolderRow[] = opts.folders ?? []
  const deckStore: DeckRow[] = opts.decks ?? []
  const componentStore: ComponentRow[] = opts.components ?? []
  const deckUpdatesStore: Record<string, UpdateRow[]> = opts.deckUpdates ?? {}
  const folderUpdatesStore: Record<string, UpdateRow[]> = opts.folderUpdates ?? {}
  const componentUpdatesStore: Record<string, UpdateRow[]> = opts.componentUpdates ?? {}

  // We intercept query chains.  The route issues these patterns:
  //   db.select({…}).from(folders).where(eq(…)).limit(1)   → folder ownership check
  //   db.select({…}).from(folderUpdates).where(eq(…)).orderBy(…) → folder doc updates
  //   db.select({…}).from(decks).where(eq(…)).orderBy(…)   → list decks
  //   db.select({…}).from(deckUpdates).where(eq(…)).orderBy(…) → deck updates
  //   db.select({…}).from(components).where(eq(…)).orderBy(…) → list components
  //   db.select({…}).from(componentUpdates).where(eq(…)).orderBy(…) → component updates
  //
  // We track which table was passed to `from()` to dispatch the right mock.

  const makeChain = (tableName: string, filterId?: string) => {
    const resolve = () => {
      switch (tableName) {
        case 'folders':
          return Promise.resolve(
            filterId !== undefined ? folderStore.filter((f) => f.id === filterId) : folderStore,
          )
        case 'decks':
          return Promise.resolve(
            filterId !== undefined ? deckStore.filter((d) => d.folderId === filterId) : deckStore,
          )
        case 'deck_updates':
          return Promise.resolve(filterId !== undefined ? (deckUpdatesStore[filterId] ?? []) : [])
        case 'folder_updates':
          return Promise.resolve(filterId !== undefined ? (folderUpdatesStore[filterId] ?? []) : [])
        case 'components':
          return Promise.resolve(
            filterId !== undefined
              ? componentStore.filter((c) => c.folderId === filterId)
              : componentStore,
          )
        case 'component_updates':
          return Promise.resolve(
            filterId !== undefined ? (componentUpdatesStore[filterId] ?? []) : [],
          )
        default:
          return Promise.resolve([])
      }
    }

    return {
      orderBy: vi.fn().mockImplementation(resolve),
      limit: vi.fn().mockImplementation(() => resolve().then((rows) => rows.slice(0, 1))),
      where: vi.fn().mockImplementation((_cond: unknown) => ({
        orderBy: vi.fn().mockImplementation(resolve),
        limit: vi.fn().mockImplementation(() => resolve().then((rows) => rows.slice(0, 1))),
      })),
    }
  }

  // Map drizzle table objects to their names. We identify tables by their
  // structure at import time — the simplest approach is to track by reference.
  // Since we can't intercept drizzle internals cleanly in tests, we use the
  // actual table objects from schema and check which one `from` receives.
  // Import them here so vi.fn() wraps the right dispatch.
  let callIndex = 0
  // Each .select().from(X).where(Y)... call is sequential and predictable.
  // We build a queue-based mock driven by the opts.

  // Simpler approach: just mock the select chain to return appropriate data
  // based on a call counter that we reset per-test.  The route always issues
  // calls in the same order for a given scenario.

  // Order for GET /folders/F/tokens/colors/T/usages:
  //   1) SELECT from folders WHERE id = F LIMIT 1 → folder row
  //   2) SELECT from folder_updates WHERE folderId = F ORDER BY id → folder update rows
  //   3) SELECT from decks WHERE folderId = F ORDER BY createdAt → deck rows
  //   4+) For each deck: SELECT from deck_updates WHERE deckId = D ORDER BY id
  //   N+) SELECT from components WHERE folderId = F ORDER BY createdAt → component rows
  //   N+1+) For each component: SELECT from component_updates WHERE componentId = C ORDER BY id

  // For non-colors categories: step 2 is skipped.

  const callQueue: Array<() => Promise<unknown[]>> = []

  function buildQueue(folderId: string, category: string) {
    callQueue.length = 0
    callIndex = 0

    // 1. Folder ownership check
    callQueue.push(() => Promise.resolve(folderStore.filter((f) => f.id === folderId).slice(0, 1)))

    // 2. Folder doc updates (only for colors)
    if (category === 'colors') {
      callQueue.push(() => Promise.resolve(folderUpdatesStore[folderId] ?? []))
    }

    // 3. Deck list
    const folderDecks = deckStore.filter((d) => d.folderId === folderId)
    callQueue.push(() => Promise.resolve(folderDecks))

    // 4. Single batched deck-updates query (inArray over all deckIds in folder).
    //    Returns rows shaped like { deckId, id, update }.
    if (folderDecks.length > 0) {
      callQueue.push(() => {
        const rows: Array<{ deckId: string; id: number; update: Uint8Array }> = []
        let id = 1
        for (const deck of folderDecks) {
          for (const u of deckUpdatesStore[deck.id] ?? []) {
            rows.push({ deckId: deck.id, id: id++, update: u.update })
          }
        }
        return Promise.resolve(rows)
      })
    }

    // 5. Component list
    const folderComponents = componentStore.filter((c) => c.folderId === folderId)
    callQueue.push(() => Promise.resolve(folderComponents))

    // 6. Single batched component-updates query (inArray over all componentIds).
    if (folderComponents.length > 0) {
      callQueue.push(() => {
        const rows: Array<{ componentId: string; id: number; update: Uint8Array }> = []
        let id = 1
        for (const comp of folderComponents) {
          for (const u of componentUpdatesStore[comp.id] ?? []) {
            rows.push({ componentId: comp.id, id: id++, update: u.update })
          }
        }
        return Promise.resolve(rows)
      })
    }
  }

  // Expose a way for the test to prime the queue before each inject
  const db = {
    _primeQueue: buildQueue,
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => {
        const idx = callIndex++
        const resolver = callQueue[idx]
        const result = resolver ? resolver() : Promise.resolve([])

        return {
          where: vi.fn().mockImplementation(() => ({
            limit: vi
              .fn()
              .mockImplementation(() => result.then((rows) => (rows as unknown[]).slice(0, 1))),
            orderBy: vi.fn().mockImplementation(() => result),
          })),
          orderBy: vi.fn().mockImplementation(() => result),
          limit: vi
            .fn()
            .mockImplementation(() => result.then((rows) => (rows as unknown[]).slice(0, 1))),
        }
      }),
    })),
  }

  return db as unknown as Database
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildApp(db: Database, bypass = true): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  registerAuthPlugin(app, { bypass, db })
  registerSameOriginPolicy(app, { allowedOrigins: [SPA] })
  await registerTokenRoutes(app, db)
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /folders/:folderId/tokens/:category/:tokenId/usages', () => {
  beforeEach(() => vi.clearAllMocks())

  const now = new Date()

  it('returns empty usages for a folder with no decks or components', async () => {
    const db = makeMockDb({
      folders: [{ id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder', createdAt: now }],
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-1',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/folders/folder-1/tokens/colors/token-abc/usages',
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { usages: unknown[] }
    expect(body.usages).toEqual([])
  })

  it('returns a deck entry when a deck object fill references the color token', async () => {
    const tokenId = 'colorXXXX01'
    const tokenKey = `colors.${tokenId}`
    const deckUpdate = makeDeckDocWithTokenRef(tokenKey)

    const db = makeMockDb({
      folders: [{ id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder', createdAt: now }],
      decks: [{ id: 'deck-1', title: 'Slide deck', folderId: 'folder-1', createdAt: now }],
      deckUpdates: { 'deck-1': [{ update: deckUpdate }] },
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-1',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/folders/folder-1/tokens/colors/${tokenId}/usages`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { usages: unknown[] }
    expect(body.usages).toHaveLength(1)
    const entry = body.usages[0] as {
      kind: string
      deckId: string
      deckTitle: string
      slideIndex: number
      objectId: string
      field: string
    }
    expect(entry.kind).toBe('deck')
    expect(entry.deckId).toBe('deck-1')
    expect(entry.deckTitle).toBe('Slide deck')
    expect(entry.slideIndex).toBe(0)
    expect(entry.objectId).toBe('obj-1')
    expect(entry.field).toBe('fill')
  })

  it('returns empty usages when a deck has objects but no matching token refs', async () => {
    const tokenId = 'colorYYYY02'
    const deckUpdate = makeDeckDocWithNoRefs()

    const db = makeMockDb({
      folders: [{ id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder', createdAt: now }],
      decks: [{ id: 'deck-2', title: 'Clean deck', folderId: 'folder-1', createdAt: now }],
      deckUpdates: { 'deck-2': [{ update: deckUpdate }] },
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-1',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/folders/folder-1/tokens/colors/${tokenId}/usages`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { usages: unknown[] }
    expect(body.usages).toEqual([])
  })

  it('returns a component entry when a component object stroke references the color token', async () => {
    const tokenId = 'colorZZZZ03'
    const tokenKey = `colors.${tokenId}`
    const compUpdate = makeComponentDocWithTokenRef(tokenKey)

    const db = makeMockDb({
      folders: [{ id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder', createdAt: now }],
      components: [{ id: 'comp-1', folderId: 'folder-1', name: 'Button', createdAt: now }],
      componentUpdates: { 'comp-1': [{ update: compUpdate }] },
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-1',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/folders/folder-1/tokens/colors/${tokenId}/usages`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { usages: unknown[] }
    expect(body.usages).toHaveLength(1)
    const entry = body.usages[0] as {
      kind: string
      componentId: string
      componentName: string
      field: string
    }
    expect(entry.kind).toBe('component')
    expect(entry.componentId).toBe('comp-1')
    expect(entry.componentName).toBe('Button')
    expect(entry.field).toBe('stroke')
  })

  it('returns a textStyle entry when a text style color references the color token', async () => {
    const tokenId = 'colorTTTT04'
    const tokenKey = `colors.${tokenId}`
    const folderUpdate = makeFolderDocWithTextStyleRef(tokenKey)

    const db = makeMockDb({
      folders: [{ id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder', createdAt: now }],
      folderUpdates: { 'folder-1': [{ update: folderUpdate }] },
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-1',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: `/folders/folder-1/tokens/colors/${tokenId}/usages`,
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { usages: unknown[] }
    expect(body.usages).toHaveLength(1)
    const entry = body.usages[0] as {
      kind: string
      styleId: string
      styleName: string
      field: string
    }
    expect(entry.kind).toBe('textStyle')
    expect(entry.styleId).toBe('style-1')
    expect(entry.styleName).toBe('Heading')
    expect(entry.field).toBe('color')
  })

  it('returns 403 when the caller does not own the folder', async () => {
    const db = makeMockDb({
      folders: [{ id: 'folder-x', ownerUserId: 'other-user', name: 'Theirs', createdAt: now }],
    })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-x',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/folders/folder-x/tokens/colors/any-id/usages',
    })

    expect(res.statusCode).toBe(403)
  })

  it('returns 404 when the folder does not exist', async () => {
    const db = makeMockDb({ folders: [] })
    ;(db as unknown as { _primeQueue: (f: string, c: string) => void })._primeQueue(
      'folder-missing',
      'colors',
    )

    const app = await buildApp(db)
    const res = await app.inject({
      method: 'GET',
      url: '/folders/folder-missing/tokens/colors/any-id/usages',
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Token writes
// ---------------------------------------------------------------------------

describe('token writes', () => {
  const folderRow = { id: 'folder-1', ownerUserId: 'dev-user', name: 'My folder' }

  /** The stored folder document: one colour and a built-in text style (fixed bytes). */
  const stored = (() => {
    const doc = new Y.Doc()
    addFolderToken(doc, 'colors', 'brand', { name: 'Brand', value: '#2040c0' })
    addFolderToken(doc, 'textStyles', 'title', { name: 'Title', size: 72, builtin: true })
    return Y.encodeStateAsUpdate(doc)
  })()
  const storedFolder = (): Array<{ update: Uint8Array }> => [{ update: stored }]

  /** The folder document after the delta rows a request wrote. */
  function folderAfter(writes: Array<{ table: string; values?: unknown }>) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, stored)
    for (const w of writes)
      if (w.table === 'folder_updates')
        Y.applyUpdate(doc, (w.values as { update: Uint8Array }).update)
    return readFolderTokens(doc)
  }

  it('POST adds a token (normalised as token.create stores it) → 201 { tokenId }', async () => {
    const db = scriptedDb({ selects: [[folderRow], storedFolder()] })
    const app = await buildApp(db.db)
    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/tokens/colors',
      payload: { name: 'Accent', value: '#F80' },
    })
    expect(res.statusCode).toBe(201)
    const { tokenId } = res.json() as { tokenId: string }
    expect(folderAfter(db.writes).colors[tokenId]).toEqual({
      id: tokenId,
      name: 'Accent',
      value: '#ff8800',
    })
  })

  it('POST refuses invalid fields with the issues, before touching the folder', async () => {
    const db = scriptedDb()
    const app = await buildApp(db.db)
    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/tokens/textStyles',
      payload: { name: 'Big', size: -3, bogus: 1 },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string; issues: Array<{ path: string[] }> }
    expect(body.error).toBe('Invalid token')
    expect(body.issues.map((i) => i.path.join('.'))).toEqual(expect.arrayContaining(['size']))
    expect(db.writes).toEqual([])
  })

  it('POST refuses an unknown category', async () => {
    const app = await buildApp(scriptedDb().db)
    const res = await app.inject({
      method: 'POST',
      url: '/folders/folder-1/tokens/gradients',
      payload: { name: 'X' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('PATCH changes a token (null removes a field) and reports the propagation', async () => {
    const db = scriptedDb({
      // Ownership, the folder document; then the propagation reads the folder
      // afresh and lists its decks and components.
      selects: [[folderRow], storedFolder(), storedFolder(), [], []],
    })
    const app = await buildApp(db.db)
    const res = await app.inject({
      method: 'PATCH',
      url: '/folders/folder-1/tokens/textStyles/title',
      payload: { size: null, weight: 700 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      // What the fields were before: `token.update` with them undoes it.
      previous: { size: 72, weight: null },
      propagated: { decks: 0, components: 0, objects: 0, failed: [] },
    })
    const title = folderAfter(db.writes).textStyles['title']
    expect(title).toMatchObject({ weight: 700 })
    expect(title?.size).toBeUndefined()
  })

  it('PATCH refuses an empty change and an unknown token', async () => {
    const empty = await (
      await buildApp(scriptedDb().db)
    ).inject({
      method: 'PATCH',
      url: '/folders/folder-1/tokens/colors/brand',
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    const db = scriptedDb({ selects: [[folderRow], storedFolder()] })
    const unknown = await (
      await buildApp(db.db)
    ).inject({
      method: 'PATCH',
      url: '/folders/folder-1/tokens/colors/nope',
      payload: { value: '#000000' },
    })
    expect(unknown.statusCode).toBe(404)
    expect(db.writes).toEqual([])
  })

  it('DELETE removes a colour and refuses a built-in text style', async () => {
    const db = scriptedDb({ selects: [[folderRow], storedFolder()] })
    const res = await (
      await buildApp(db.db)
    ).inject({
      method: 'DELETE',
      url: '/folders/folder-1/tokens/colors/brand',
    })
    expect(res.statusCode).toBe(200)
    expect(folderAfter(db.writes).colors['brand']).toBeUndefined()

    const builtin = await (
      await buildApp(scriptedDb({ selects: [[folderRow], storedFolder()] }).db)
    ).inject({ method: 'DELETE', url: '/folders/folder-1/tokens/textStyles/title' })
    expect(builtin.statusCode).toBe(409)
  })

  it('refuses a signed-in session from another origin before touching the folder', async () => {
    const db = scriptedDb()
    const app = await buildApp(db.db, false)
    const cookie = 'narrative_session=s-dev-user-1'
    for (const origin of [undefined, 'https://evil.example']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/folders/folder-1/tokens/colors/brand',
        headers: { cookie, ...(origin === undefined ? {} : { origin }) },
        payload: { value: '#000000' },
      })
      expect(res.statusCode).toBe(403)
      expect(res.json()).toMatchObject({ error: 'forbidden_origin' })
    }
    expect(db.writes).toEqual([])
  })

  it('refuses a token id that is not one', async () => {
    const res = await (
      await buildApp(scriptedDb().db)
    ).inject({
      method: 'DELETE',
      url: `/folders/folder-1/tokens/colors/${'x'.repeat(80)}`,
    })
    expect(res.statusCode).toBe(400)
  })

  it("refuses another user's folder", async () => {
    const db = scriptedDb({ selects: [[{ ...folderRow, ownerUserId: 'someone-else' }]] })
    const res = await (
      await buildApp(db.db)
    ).inject({
      method: 'POST',
      url: '/folders/folder-1/tokens/colors',
      payload: { name: 'X', value: '#000000' },
    })
    expect(res.statusCode).toBe(403)
  })
})
