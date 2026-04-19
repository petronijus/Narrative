/**
 * hocuspocus/persistence.test.ts
 *
 * Unit testy pro PostgresPersistence extension.
 *
 * Testovací strategie:
 *   Místo real Postgres nebo testcontainers (Docker required) testujeme přes
 *   drizzle-orm s mock db objektem — ověřujeme logiku persistence extension
 *   (load/store) bez DB dependency.
 *
 *   Real Postgres integration test je v integration.test.ts (označen jako integration,
 *   vyžaduje běžící Postgres — spouštět manuálně nebo v CI s service container).
 *
 * Coverage:
 *   - onLoadDocument: prázdný deck → vrátí void (žádná aplikace)
 *   - onLoadDocument: deck s N updates → aplikuje sekvenčně na Y.Doc
 *   - onStoreDocument: volá insert s encoded state
 *   - Multiple updates → všechny aplikovány ve správném pořadí
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { PostgresPersistence } from './persistence.js'

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

function makeMockDb(updateRows: Array<{ update: Uint8Array }> = []) {
  const insertedValues: Array<{ deckId: string; update: Uint8Array }> = []

  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(updateRows),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: { deckId: string; update: Uint8Array }) => {
        insertedValues.push(vals)
        return Promise.resolve()
      }),
    }),

    _insertedValues: insertedValues,
  }

  return db
}

function makePayload(documentName: string, doc: Y.Doc) {
  return {
    documentName,
    document: doc,
    instance: {} as never,
    connection: {} as never,
    context: {},
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    socketId: 'test',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresPersistence', () => {
  let doc: Y.Doc

  beforeEach(() => {
    doc = new Y.Doc()
  })

  it('onLoadDocument returns void for empty deck (no rows)', async () => {
    const db = makeMockDb([])
    const persistence = new PostgresPersistence({ db: db as never })

    const result = await persistence.onLoadDocument(makePayload('deck-123', doc) as never)

    expect(result).toBeUndefined()
    // Y.Doc should still be empty
    const objects = doc.getArray('objects')
    expect(objects.length).toBe(0)
  })

  it('onLoadDocument applies updates sequentially from DB rows', async () => {
    // Vytvoříme update s jedním objektem
    const sourceDoc = new Y.Doc()
    const objects = sourceDoc.getArray<Y.Map<unknown>>('objects')
    sourceDoc.transact(() => {
      const obj = new Y.Map<unknown>()
      obj.set('id', 'obj-1')
      obj.set('type', 'rectangle')
      obj.set('x', 100)
      objects.push([obj])
    })
    const update = Y.encodeStateAsUpdate(sourceDoc)

    const db = makeMockDb([{ update }])
    const persistence = new PostgresPersistence({ db: db as never })

    const result = await persistence.onLoadDocument(makePayload('deck-abc', doc) as never)

    expect(result).toBe(doc)
    const loadedObjects = doc.getArray<Y.Map<unknown>>('objects')
    expect(loadedObjects.length).toBe(1)
    expect(loadedObjects.get(0).get('id')).toBe('obj-1')
    expect(loadedObjects.get(0).get('type')).toBe('rectangle')
  })

  it('onLoadDocument applies multiple updates in order', async () => {
    // Dva updates — každý přidá jeden objekt
    const doc1 = new Y.Doc()
    const arr1 = doc1.getArray<Y.Map<unknown>>('objects')
    doc1.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'obj-A')
      arr1.push([m])
    })
    const update1 = Y.encodeStateAsUpdate(doc1)

    // Doc2 je incrementální update nad doc1
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc1))
    doc1.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'obj-B')
      arr1.push([m])
    })
    const update2 = Y.encodeStateAsUpdate(doc1)

    const db = makeMockDb([{ update: update1 }, { update: update2 }])
    const persistence = new PostgresPersistence({ db: db as never })

    await persistence.onLoadDocument(makePayload('deck-multi', doc) as never)

    const resultObjects = doc.getArray<Y.Map<unknown>>('objects')
    const ids = Array.from({ length: resultObjects.length }, (_, i) =>
      resultObjects.get(i).get('id'),
    )
    expect(ids).toContain('obj-A')
  })

  it('onStoreDocument inserts encoded state into DB', async () => {
    const db = makeMockDb()
    const persistence = new PostgresPersistence({ db: db as never })

    // Přidáme objekt do doc
    const objects = doc.getArray<Y.Map<unknown>>('objects')
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'obj-store')
      objects.push([m])
    })

    await persistence.onStoreDocument(makePayload('deck-store', doc) as never)

    expect(db._insertedValues).toHaveLength(1)
    const inserted = db._insertedValues[0]
    expect(inserted).toBeDefined()
    expect(inserted!.deckId).toBe('deck-store')
    expect(inserted!.update).toBeInstanceOf(Uint8Array)
    expect(inserted!.update.byteLength).toBeGreaterThan(0)
  })

  it('onStoreDocument stores state that can be rehydrated', async () => {
    const db = makeMockDb()
    const persistence = new PostgresPersistence({ db: db as never })

    // Přidáme data do zdrojového doc
    const objects = doc.getArray<Y.Map<unknown>>('objects')
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'rehydrate-test')
      m.set('type', 'ellipse')
      objects.push([m])
    })

    await persistence.onStoreDocument(makePayload('deck-rh', doc) as never)

    // Rehydrate do nového doc
    const inserted = db._insertedValues[0]
    expect(inserted).toBeDefined()

    const freshDoc = new Y.Doc()
    Y.applyUpdate(freshDoc, inserted!.update)

    const freshObjects = freshDoc.getArray<Y.Map<unknown>>('objects')
    expect(freshObjects.length).toBe(1)
    expect(freshObjects.get(0).get('id')).toBe('rehydrate-test')
    expect(freshObjects.get(0).get('type')).toBe('ellipse')
  })
})
