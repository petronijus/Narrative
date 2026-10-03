/**
 * services/documents.test.ts — the services that read or write Yjs
 * documents, against a real (non-listening) Hocuspocus instance with
 * in-memory persistence and a scripted Drizzle client:
 *   - liveDocs: reads prefer the live copy, writes are ONE transaction with
 *     the caller's origin through a direct connection;
 *   - decks.create writes the first slide with the deck;
 *   - decks.list / listPage show the higher of the deck grant and the
 *     folder role (no creator fallback);
 *   - decks.moveDecks authorises the move (editor of both folders, owner of
 *     every moved deck), moves all or none, closes the live connections on
 *     the moved decks and the source folder's token document, and rebinds
 *     the moved deck's token references;
 *   - decks.delete closes the deleted deck's connections and its folder's;
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
import { localiseLinkedMedia } from './localiseMedia.js'
import { createDecksService } from './decks.js'
import { createComponentsService } from './components.js'
import { createPptxService } from './pptx.js'
import { closeConnectionsForDocument, closeDeckConnections } from '../hocuspocus/connections.js'

// Moving a deck copies the media it links from its old folder
// (services/localiseMedia.ts, its own tests against Postgres); here that the
// move asks for it, before and after, and what it does with the answers.
const LOCALISED_NOTHING = {
  copied: 0,
  repointed: 0,
  unresolved: 0,
  refused: 0,
  copyFailed: 0,
  replaced: new Set<string>(),
}
vi.mock('./localiseMedia.js', () => ({
  localiseLinkedMedia: vi.fn(),
  carryLinkedMediaAfterWrite: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../media/bucketCleanup.js', () => ({
  purgeDeckBucketPrefix: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeComponentBucketPrefix: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeExplicitKeys: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  purgeUnreferencedKeys: vi.fn().mockResolvedValue({ deleted: 0, pages: 0, errors: 0 }),
  sweepAgainAfterGrace: vi.fn(),
}))

// The services close live WebSocket connections through the process-wide
// server registry; here we only record that they asked to.
vi.mock('../hocuspocus/connections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hocuspocus/connections.js')>()),
  closeDeckConnections: vi.fn(() => 0),
  closeConnectionsForDocument: vi.fn(() => 0),
}))

const closedDecks = vi.mocked(closeDeckConnections)
const closedDocuments = vi.mocked(closeConnectionsForDocument)

let persistence: MemoryPersistence
let hp: Hocuspocus

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(localiseLinkedMedia).mockReset().mockResolvedValue(LOCALISED_NOTHING)
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
      // The folder, then the caller's role in it (someone else's folder they edit).
      selects: [[{ id: 'f1', ownerUserId: 'someone-else', name: 'Team' }], [{ role: 'editor' }]],
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

  it('refuses a folder the user is not a member of, and one they only view', async () => {
    for (const roleRows of [[], [{ role: 'viewer' }]]) {
      const script = scriptedDb({
        selects: [[{ id: 'f1', ownerUserId: 'someone-else', name: 'Team' }], roleRows],
      })
      const err = await serviceErrorOf(
        createDecksService(deps(script.db)).create({ userId: 'u1', folderId: 'f1' }),
      )
      expect(err).toBeInstanceOf(ServiceError)
      expect((err as ServiceError).status).toBe(403)
      expect(script.writes).toEqual([])
    }
  })
})

describe('decks.list / decks.listPage: the role shown for each deck', () => {
  const deckRow = (id: string) => ({
    id,
    title: id,
    ownerUserId: 'the-creator',
    folderId: 'f1',
    thumbnailKey: null,
    thumbnailUpdatedAt: null,
    createdAt: new Date('2026-09-30'),
    updatedAt: new Date('2026-09-30'),
  })

  it('lists the higher of the deck grant and the folder role, never the creator column', async () => {
    const script = scriptedDb({
      selects: [
        [
          { deck: deckRow('grant-wins'), deckRole: 'owner', folderRole: 'viewer' },
          { deck: deckRow('folder-wins'), deckRole: 'viewer', folderRole: 'editor' },
          { deck: deckRow('grant-only'), deckRole: 'editor', folderRole: null },
          { deck: deckRow('folder-only'), deckRole: null, folderRole: 'viewer' },
        ],
      ],
    })
    // The caller is decks.owner_user_id of every deck: that grants nothing.
    const listed = await createDecksService(deps(script.db)).list({ userId: 'the-creator' })
    expect(listed.map((d) => [d.id, d.viewerRole])).toEqual([
      ['grant-wins', 'owner'],
      ['folder-wins', 'editor'],
      ['grant-only', 'editor'],
      ['folder-only', 'viewer'],
    ])
  })

  it('pages with the same role rule', async () => {
    const at = new Date('2026-09-30T10:00:00Z')
    const item = (id: string, deckRole: string | null, folderRole: string | null) => ({
      id,
      title: id,
      folderId: 'f1',
      updatedAt: at,
      key: '2026-09-30T10:00:00.000000',
      deckRole,
      folderRole,
    })
    const script = scriptedDb({
      selects: [
        [
          item('grant-wins', 'owner', 'viewer'),
          item('folder-wins', 'viewer', 'editor'),
          item('folder-only', null, 'viewer'),
        ],
      ],
    })
    const page = await createDecksService(deps(script.db)).listPage({
      userId: 'the-creator',
      limit: 10,
    })
    expect(page.decks.map((d) => [d.id, d.role])).toEqual([
      ['grant-wins', 'owner'],
      ['folder-wins', 'editor'],
      ['folder-only', 'viewer'],
    ])
    expect(page.next).toBeNull()
  })
})

describe('decks.moveDecks', () => {
  const SRC = { id: 'f_src', ownerUserId: 'u1', name: 'Client A' }
  const DST = { id: 'f_dst', ownerUserId: 'u1', name: 'Client B' }
  const moveArgs = (deckIds: string[]) => ({
    userId: 'u1',
    sourceFolderId: 'f_src',
    deckIds,
    destFolderId: 'f_dst',
  })

  it('moves the deck and rebinds its token references to the destination folder', async () => {
    persistence.snapshots.set('d1', deckState({ $token: 'colors.src_brand' }))
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'editor' }], // the caller edits the source folder…
        [DST],
        [{ role: 'editor' }], // …and the destination
        [{ id: 'd1', folderId: 'f_src' }],
        [{ deckId: 'd1' }], // the caller's owner grants on the moved decks
        // the two folder documents (stored rows), source first
        [{ update: folderState({ src_brand: { name: 'Brand', value: '#0033aa' } }) }],
        [{ update: folderState({ dst_brand: { name: 'brand', value: '#0044bb' } }) }],
      ],
      updates: [[{ id: 'd1' }]],
    })
    const origin = { run: 'r1' }
    const result = await createDecksService(deps(script.db)).moveDecks({
      ...moveArgs(['d1']),
      origin,
    })
    expect(result).toEqual({
      movedCount: 1,
      tokens: [{ deckId: 'd1', rebound: 1, literalised: 0, detached: 0, unmatched: 0 }],
      media: [{ deckId: 'd1', copied: 0, unresolved: 0, copyFailed: 0 }],
    })
    expect(firstFill(persistence.snapshots.get('d1'))).toEqual({ $token: 'colors.dst_brand' })
    // The move itself is the folder change alone: the copies and their
    // record are the localisation's (deck_moved_media, its own tests).
    expect(script.writes).toEqual([
      expect.objectContaining({ kind: 'update', table: 'decks', values: expect.objectContaining({ folderId: 'f_dst' }) }),
    ])
    // The linked media of the source folder: localised before the move, and
    // once more after it for anything linked meanwhile.
    const localise = { userId: 'u1', deckId: 'd1', fromFolderId: 'f_src', toFolderId: 'f_dst' }
    expect(vi.mocked(localiseLinkedMedia).mock.calls.map((c) => c[1])).toEqual([localise, localise])
  })

  it('moves nothing when a linked picture cannot be copied into the deck first', async () => {
    vi.mocked(localiseLinkedMedia).mockResolvedValueOnce({
      ...LOCALISED_NOTHING,
      copied: 2,
      copyFailed: 1,
    })
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
      ],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks(moveArgs(['d1'])),
    )
    expect(err.status).toBe(503)
    expect(err.message).toMatch(/could not be copied into it, so no deck changed folders/)
    expect(err.message).toMatch(/copies already made are reused/)
    expect(script.writes).toEqual([])
    expect(closedDecks).not.toHaveBeenCalled()
    expect(vi.mocked(localiseLinkedMedia)).toHaveBeenCalledTimes(1)
  })

  it('moves nothing when a linked picture may not be copied by the mover', async () => {
    vi.mocked(localiseLinkedMedia).mockResolvedValueOnce({
      ...LOCALISED_NOTHING,
      unresolved: 1,
      refused: 1,
    })
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
      ],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks(moveArgs(['d1'])),
    )
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/may not be copied by you, so no deck changed folders/)
    expect(script.writes).toEqual([])
    expect(closedDecks).not.toHaveBeenCalled()
  })

  it('counts copies an earlier attempt made, reused, as taken along', async () => {
    vi.mocked(localiseLinkedMedia)
      .mockResolvedValueOnce({ ...LOCALISED_NOTHING, copied: 1, repointed: 2 })
      .mockResolvedValueOnce(LOCALISED_NOTHING)
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
        [],
        [],
      ],
      updates: [[{ id: 'd1' }]],
    })
    const result = await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1']))
    expect(result.media).toEqual([{ deckId: 'd1', copied: 3, unresolved: 0, copyFailed: 0 }])
  })

  it('moves despite references that were broken already, and reports what the catch-up could not copy', async () => {
    vi.mocked(localiseLinkedMedia)
      .mockResolvedValueOnce({ ...LOCALISED_NOTHING, copied: 1, unresolved: 2 })
      .mockResolvedValueOnce({ ...LOCALISED_NOTHING, copied: 1, unresolved: 2, copyFailed: 1 })
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
        [],
        [],
      ],
      updates: [[{ id: 'd1' }]],
    })
    const result = await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1']))
    expect(result.movedCount).toBe(1)
    expect(result.media).toEqual([{ deckId: 'd1', copied: 2, unresolved: 2, copyFailed: 1 }])
  })

  it('reports a catch-up that failed as a whole; the move stands', async () => {
    vi.mocked(localiseLinkedMedia)
      .mockResolvedValueOnce({ ...LOCALISED_NOTHING, copied: 1 })
      .mockRejectedValueOnce(new Error('sync server gone'))
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
        [],
        [],
      ],
      updates: [[{ id: 'd1' }]],
    })
    const result = await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1']))
    expect(result.movedCount).toBe(1)
    expect(result.media).toEqual([
      { deckId: 'd1', copied: 1, unresolved: 0, copyFailed: 0, error: 'sync server gone' },
    ])
  })

  it("lets the source folder's owner move a deck without reading the deck grants", async () => {
    // No grant select is scripted: had the service read the grants, the
    // empty source-folder document below would answer it and refuse the move.
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
        [], // the source folder document (empty: no tokens to rebind)
        [], // the destination folder document
      ],
      updates: [[{ id: 'd1' }]],
    })
    const result = await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1']))
    expect(result.movedCount).toBe(1)
    expect(script.remaining().selects).toBe(0)
  })

  it('lets a source folder editor move the decks they hold an owner grant on', async () => {
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'editor' }],
        [DST],
        [{ role: 'editor' }],
        [
          { id: 'd1', folderId: 'f_src' },
          { id: 'd2', folderId: 'f_src' },
        ],
        [{ deckId: 'd1' }, { deckId: 'd2' }], // one query: owner grants on both
        [],
        [],
      ],
      updates: [[{ id: 'd1' }, { id: 'd2' }]],
    })
    const result = await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1', 'd2']))
    expect(result.movedCount).toBe(2)
    expect(script.remaining().selects).toBe(0)
  })

  it('refuses a deck the caller only edits through the folder, before moving anything', async () => {
    // An editor of both folders who holds no owner grant on the deck:
    // moving it changes who sees it.
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'editor' }],
        [DST],
        [{ role: 'editor' }],
        [{ id: 'd1', folderId: 'f_src' }],
        [], // no owner grant
      ],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks(moveArgs(['d1'])),
    )
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/owner role/)
    expect(script.writes).toEqual([])
    expect(script.remaining().selects).toBe(0)
    expect(closedDecks).not.toHaveBeenCalled()
    expect(closedDocuments).not.toHaveBeenCalled()
  })

  it('refuses the whole move when the caller owns only some of the decks', async () => {
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'editor' }],
        [DST],
        [{ role: 'editor' }],
        [
          { id: 'd1', folderId: 'f_src' },
          { id: 'd2', folderId: 'f_src' },
        ],
        [{ deckId: 'd1' }], // an owner grant on d1 only
      ],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks(moveArgs(['d1', 'd2'])),
    )
    expect(err.status).toBe(403)
    expect(script.writes).toEqual([])
  })

  it('rolls the move back with a conflict when a deck left the source folder meanwhile', async () => {
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [
          { id: 'd1', folderId: 'f_src' },
          { id: 'd2', folderId: 'f_src' },
        ],
      ],
      // The guarded update (id in … and folder_id = source) moved only d1.
      updates: [[{ id: 'd1' }]],
    })
    const err = await serviceErrorOf(
      createDecksService(deps(script.db)).moveDecks(moveArgs(['d1', 'd2'])),
    )
    expect(err.status).toBe(409)
    expect(err.message).toBe('Some decks left the source folder while they were being moved')
    expect(script.writes).toEqual([])
    expect(script.rolledBack).toMatchObject([
      { kind: 'update', table: 'decks', values: { folderId: 'f_dst' } },
    ])
    expect(closedDecks).not.toHaveBeenCalled()
    expect(closedDocuments).not.toHaveBeenCalled()
  })

  it("closes the moved decks' connections and the source folder document's", async () => {
    const script = scriptedDb({
      selects: [
        [SRC],
        [{ role: 'owner' }],
        [DST],
        [{ role: 'editor' }],
        [
          { id: 'd1', folderId: 'f_src' },
          { id: 'd2', folderId: 'f_src' },
        ],
        [],
        [],
      ],
      updates: [[{ id: 'd1' }, { id: 'd2' }]],
    })
    await createDecksService(deps(script.db)).moveDecks(moveArgs(['d1', 'd2']))
    expect(closedDecks.mock.calls).toEqual([['d1'], ['d2']])
    expect(closedDocuments.mock.calls).toEqual([['folder:f_src']])
  })
})

describe('decks.delete', () => {
  it("closes the deleted deck's connections and its folder document's", async () => {
    const script = scriptedDb({
      selects: [[]], // the deck's media rows
      deletes: [[{ id: 'd1', folderId: 'f1' }]],
    })
    await createDecksService(deps(script.db)).delete({ deckId: 'd1' })
    expect(closedDecks.mock.calls).toEqual([['d1']])
    expect(closedDocuments.mock.calls).toEqual([['folder:f1']])
  })

  it('closes no folder document for a deck in no folder', async () => {
    const script = scriptedDb({ selects: [[]], deletes: [[{ id: 'd1', folderId: null }]] })
    await createDecksService(deps(script.db)).delete({ deckId: 'd1' })
    expect(closedDecks.mock.calls).toEqual([['d1']])
    expect(closedDocuments).not.toHaveBeenCalled()
  })

  it('closes nothing when the deck does not exist', async () => {
    const script = scriptedDb({ selects: [[]], deletes: [[]] })
    const err = await serviceErrorOf(createDecksService(deps(script.db)).delete({ deckId: 'd1' }))
    expect(err.status).toBe(404)
    expect(closedDecks).not.toHaveBeenCalled()
    expect(closedDocuments).not.toHaveBeenCalled()
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
        [{ role: 'viewer' }], // the caller's role in its folder: reading a master needs viewer
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

  it('refuses a component in a folder the user is not a member of', async () => {
    const script = scriptedDb({ selects: [[componentRow], []] })
    const err = await serviceErrorOf(
      createComponentsService(deps(script.db)).access({ userId: 'u1', componentId: 'cmp1' }),
    )
    expect(err.status).toBe(403)
  })

  it('authorises opening a master with the role the user holds in its folder', async () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const script = scriptedDb({ selects: [[componentRow], [{ role }]] })
      expect(
        await createComponentsService(deps(script.db)).access({
          userId: 'u1',
          componentId: 'cmp1',
        }),
      ).toEqual({
        componentId: 'cmp1',
        folderId: 'f1',
        role,
        documentName: 'component:cmp1',
      })
    }
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
