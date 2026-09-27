/**
 * services/documents.test.ts — the services that read or write Yjs
 * documents, against a real (non-listening) Hocuspocus instance with
 * in-memory persistence and a scripted Drizzle client:
 *   - liveDocs: reads prefer the live copy, writes are ONE transaction with
 *     the caller's origin through a direct connection;
 *   - decks.create writes the first slide with the deck;
 *   - decks.moveDecks rebinds the moved deck's token references;
 *   - components.readMaster enforces the folder rules;
 *   - pptx export reads the live document, not the stored snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addObjects,
  addSlide,
  createSlideDoc,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  listSlides,
} from '@narrative/slide-model'
import type { RectangleObject } from '@narrative/shared'
import { MemoryPersistence, quietLog } from '../test-support/agentWorld.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'
import type { ServiceDeps } from './deps.js'
import { ServiceError } from './errors.js'
import { readDocState, writeLiveDoc } from './liveDocs.js'
import { createDecksService } from './decks.js'
import { createComponentsService } from './components.js'
import { createPptxService } from './pptx.js'

vi.mock('../media/bucketCleanup.js', () => ({
  purgeDeckBucketPrefix: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeExplicitKeys: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
}))

let persistence: MemoryPersistence
let hp: Hocuspocus

beforeEach(() => {
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({
    quiet: true,
    stopOnSignals: false,
    unloadImmediately: false,
    debounce: 10,
    maxDebounce: 50,
    extensions: [persistence],
  })
})

afterEach(async () => {
  await hp.destroy?.()
})

function deps(db: ServiceDeps['db']): ServiceDeps {
  return { db, log: quietLog, hocuspocus: () => hp }
}

function stateOf(build: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  build(doc)
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

function rect(id: string, fill: unknown): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x: 10,
    y: 10,
    width: 100,
    height: 50,
    rotation: 0,
    opacity: 1,
    fill: fill as RectangleObject['fill'],
  }
}

/** A deck document with one rectangle whose fill is `fill`. */
function deckState(fill: unknown, slides = 1): Uint8Array {
  return stateOf((doc) => {
    const deck = hydrateSlideDoc(doc)
    for (let i = 1; i < slides; i++) addSlide(deck)
    const s1 = deck.slides.get(0).get('id') as string
    addObjects(getSlideObjectsCtx(deck, s1)!, [rect('r1', fill)])
  })
}

function folderState(colors: Record<string, { name: string; value: string }>): Uint8Array {
  return stateOf((doc) => {
    const colorMap = new Y.Map<unknown>()
    doc.getMap('tokens').set('colors', colorMap)
    for (const [id, token] of Object.entries(colors)) {
      const m = new Y.Map<unknown>()
      colorMap.set(id, m)
      m.set('name', token.name)
      m.set('value', token.value)
    }
  })
}

function firstFill(state: Uint8Array | undefined): unknown {
  const doc = new Y.Doc()
  if (state !== undefined) Y.applyUpdate(doc, state)
  const deck = hydrateSlideDoc(doc)
  return listSlides(deck)[0]?.objects[0]?.['fill' as never]
}

describe('liveDocs', () => {
  it('reads the live copy when the document is loaded, else the stored rows', async () => {
    persistence.snapshots.set('d1', deckState(0x111111))
    const { db } = scriptedDb({ selects: [[{ update: deckState(0x222222) }]] })

    // Not loaded: the stored row (the scripted select) is what is read.
    expect(firstFill(await readDocState(deps(db), 'deck', 'd1'))).toBe(0x222222)

    // Loaded (someone has it open) and edited live: the live copy wins.
    const conn = await hp.openDirectConnection('d1')
    await conn.transact((doc) => {
      const deck = hydrateSlideDoc(doc)
      const objects = getSlideObjectsCtx(deck, deck.slides.get(0).get('id') as string)!
      objects.objects.get(0).set('fill', 0x333333)
    })
    expect(firstFill(await readDocState(deps(db), 'deck', 'd1'))).toBe(0x333333)
    await conn.disconnect()
  })

  it('writes in ONE transaction with the given origin, visible to connected editors', async () => {
    persistence.snapshots.set('d1', deckState(0x111111))
    const editor = await hp.openDirectConnection('d1')
    const origins: unknown[] = []
    editor.document!.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
    const origin = { agentRun: 'r1' }

    const result = await writeLiveDoc(
      deps(scriptedDb().db),
      'deck',
      'd1',
      (doc) => {
        const deck = hydrateSlideDoc(doc)
        addSlide(deck)
        addSlide(deck)
        return deck.slides.length
      },
      origin,
    )
    expect(result).toBe(3)
    expect(origins).toEqual([origin])
    expect(listSlides(hydrateSlideDoc(editor.document!))).toHaveLength(3)
    await editor.disconnect()
  })

  it('without a sync server, appends one delta row', async () => {
    const script = scriptedDb({ selects: [[{ update: deckState(0x111111) }]] })
    await writeLiveDoc(
      { db: script.db, log: quietLog, hocuspocus: () => null },
      'deck',
      'd9',
      (doc) => addSlide(hydrateSlideDoc(doc)),
    )
    expect(script.writes).toEqual([
      {
        kind: 'insert',
        table: 'deck_updates',
        values: { deckId: 'd9', update: expect.any(Uint8Array) },
      },
    ])
  })
})

describe('decks.create', () => {
  it('writes the deck, its owner permission and a first document with one empty slide, together', async () => {
    const now = new Date('2026-09-26T10:00:00Z')
    const script = scriptedDb({
      selects: [[{ id: 'f1', ownerUserId: 'u1' }]],
    })
    const created = await createDecksService(deps(script.db)).create({
      userId: 'u1',
      title: 'Pitch',
      folderId: 'f1',
    })
    expect(script.writes.map((w) => `${w.kind} ${w.table}`)).toEqual([
      'insert decks',
      'insert deck_permissions',
      'insert deck_updates',
    ])
    const snapshot = (script.writes[2]!.values as { update: Uint8Array }).update
    const doc = new Y.Doc()
    Y.applyUpdate(doc, snapshot)
    const slides = listSlides({ doc, slides: doc.getArray('slides') })
    expect(slides.map((s) => s.id)).toEqual([created.firstSlideId])
    expect(created).toMatchObject({ title: 'Pitch', folderId: 'f1', ownerUserId: 'u1' })
    void now
  })

  it("refuses a folder that is not the user's", async () => {
    const script = scriptedDb({ selects: [[{ id: 'f1', ownerUserId: 'someone-else' }]] })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).create({ userId: 'u1', folderId: 'f1' }),
    )
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).status).toBe(403)
    expect(script.writes).toEqual([])
  })
})

describe('decks.moveDecks', () => {
  it('moves the deck and rebinds its token references to the destination folder', async () => {
    persistence.snapshots.set('d1', deckState({ $token: 'colors.src_brand' }))
    const script = scriptedDb({
      selects: [
        [{ id: 'f_src', ownerUserId: 'u1', name: 'Client A' }],
        [{ id: 'f_dst', ownerUserId: 'u1', name: 'Client B' }],
        [{ id: 'd1', ownerUserId: 'u1', folderId: 'f_src' }],
        // the two folder documents (stored rows), source first
        [{ update: folderState({ src_brand: { name: 'Brand', value: '#0033aa' } }) }],
        [{ update: folderState({ dst_brand: { name: 'brand', value: '#0044bb' } }) }],
      ],
      updates: [[{ id: 'd1' }]],
    })
    const origin = { run: 'r1' }
    const result = await createDecksService(deps(script.db)).moveDecks({
      userId: 'u1',
      sourceFolderId: 'f_src',
      deckIds: ['d1'],
      destFolderId: 'f_dst',
      origin,
    })
    expect(result).toEqual({
      movedCount: 1,
      tokens: [{ deckId: 'd1', rebound: 1, literalised: 0, detached: 0, unmatched: 0 }],
    })
    expect(firstFill(persistence.snapshots.get('d1'))).toEqual({ $token: 'colors.dst_brand' })
    expect(script.writes[0]).toMatchObject({
      kind: 'update',
      table: 'decks',
      values: { folderId: 'f_dst' },
    })
  })

  it('refuses decks the caller does not own, before moving anything', async () => {
    const script = scriptedDb({
      selects: [
        [{ id: 'f_src', ownerUserId: 'u1', name: 'A' }],
        [{ id: 'f_dst', ownerUserId: 'u1', name: 'B' }],
        [{ id: 'd1', ownerUserId: 'other', folderId: 'f_src' }],
      ],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks({
        userId: 'u1',
        sourceFolderId: 'f_src',
        deckIds: ['d1'],
        destFolderId: 'f_dst',
      }),
    )
    expect(err.status).toBe(403)
    expect(script.writes).toEqual([])
  })
})

describe('components.readMaster', () => {
  const master = stateOf((doc) => {
    const deck = hydrateSlideDoc(doc)
    addObjects(getSlideObjectsCtx(deck, deck.slides.get(0).get('id') as string)!, [rect('m1', 1)])
  })
  const componentRow = {
    id: 'cmp1',
    folderId: 'f1',
    name: 'Headline',
    thumbnailKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it("reads the master of a component in the deck's folder", async () => {
    const script = scriptedDb({
      selects: [
        [{ folderId: 'f1' }], // the deck's folder
        [componentRow],
        [{ id: 'f1', ownerUserId: 'u1', name: 'A' }], // folder ownership
        [{ update: master }], // stored master
      ],
    })
    const out = await createComponentsService(deps(script.db)).readMaster({
      userId: 'u1',
      componentId: 'cmp1',
      deckId: 'd1',
    })
    expect(out.component).toMatchObject({ id: 'cmp1', name: 'Headline' })
    const doc = new Y.Doc()
    Y.applyUpdate(doc, out.state)
    expect(listSlides(hydrateSlideDoc(doc))[0]!.objects.map((o) => o.id)).toEqual(['m1'])
  })

  it("does not reach a component of another folder than the deck's", async () => {
    const script = scriptedDb({ selects: [[{ folderId: 'f2' }], [componentRow]] })
    const err = await serviceErrorOf(
      createComponentsService(deps(script.db)).readMaster({
        userId: 'u1',
        componentId: 'cmp1',
        deckId: 'd1',
      }),
    )
    expect(err.status).toBe(404)
  })

  it("refuses a component whose folder is someone else's", async () => {
    const script = scriptedDb({
      selects: [[componentRow], [{ id: 'f1', ownerUserId: 'other', name: 'A' }]],
    })
    const err = await serviceErrorOf(
      createComponentsService(deps(script.db)).access({ userId: 'u1', componentId: 'cmp1' }),
    )
    expect(err.status).toBe(403)
  })

  it('authorises opening a master for the owner', async () => {
    const script = scriptedDb({
      selects: [[componentRow], [{ id: 'f1', ownerUserId: 'u1', name: 'A' }]],
    })
    expect(
      await createComponentsService(deps(script.db)).access({ userId: 'u1', componentId: 'cmp1' }),
    ).toEqual({
      componentId: 'cmp1',
      folderId: 'f1',
      role: 'owner',
      documentName: 'component:cmp1',
    })
  })
})

describe('pptx export', () => {
  it('exports the LIVE document, including an edit the stored snapshot does not have yet', async () => {
    persistence.snapshots.set('d1', deckState(0x111111))
    const editor = await hp.openDirectConnection('d1')
    // An edit that has not been stored: the scripted DB below never sees it.
    await editor.transact((doc) => {
      addSlide(hydrateSlideDoc(doc))
    })
    const script = scriptedDb({
      selects: [
        [{ id: 'd1', title: 'Q3 review', folderId: null }], // the deck row
      ],
    })
    const out = await createPptxService(deps(script.db)).exportBytes({ deckId: 'd1' })
    expect(out.slideCount).toBe(2)
    expect(out.filename).toBe('Q3 review.pptx')
    expect(out.buffer.subarray(0, 2).toString()).toBe('PK')
    await editor.disconnect()
  })

  it('returns a small export inline as base64 (stored document, nobody has it open)', async () => {
    const stored = createSlideDoc()
    for (let i = 0; i < 2; i++) addSlide(stored)
    const script = scriptedDb({
      selects: [
        [{ id: 'd2', title: 'Deck', folderId: null }], // the deck row
        [{ update: Y.encodeStateAsUpdate(stored.doc) }], // its stored snapshot
      ],
    })
    const inline = await createPptxService(deps(script.db)).exportPptx({
      userId: 'u1',
      deckId: 'd2',
      delivery: 'base64',
    })
    expect(inline).toMatchObject({ delivery: 'base64', slideCount: 3, filename: 'Deck.pptx' })
    expect(
      Buffer.from((inline as { base64: string }).base64, 'base64')
        .subarray(0, 2)
        .toString(),
    ).toBe('PK')
  })
})
