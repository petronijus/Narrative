/**
 * services/tokens.test.ts — a folder's tokens written on the server, and a
 * token change carried into the folder's decks and component masters:
 *
 *   - create / update / delete go through the live folder document, with
 *     the colour cap and the built-in text styles enforced;
 *   - a text-style change re-styles the text boxes AND table defaults linked
 *     to it (fields set by hand stay), in an open deck, a closed deck and a
 *     component master, under TOKEN_PROPAGATION_ORIGIN;
 *   - a colour change reaches the text of the styles that use it; a rename
 *     reaches nothing, and a document with nothing to change is not written;
 *   - `ensureFolderTokens` seeds an empty folder, brings an old seed up to
 *     date, and writes nothing when there is nothing to do.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addFolderToken,
  addObjects,
  addTable,
  createSlideDoc,
  getSlideObjectsCtx,
  listSlides,
  readFolderTokens,
  setTableDefaultsPatch,
  updateFolderToken,
} from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { MemoryPersistence, quietLog } from '../test-support/agentWorld.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'
import { documentName } from './liveDocs.js'
import { TOKEN_PROPAGATION_ORIGIN, createTokensService, ensureFolderTokens } from './tokens.js'

const USER = 'u1'
const FOLDER = 'f1'
const folderRow = { id: FOLDER, ownerUserId: USER, name: 'Client' }

let hp: Hocuspocus
let persistence: MemoryPersistence
/** Direct connections kept open, so their documents stay loaded ("someone has it open"). */
let open: Array<{ disconnect: () => Promise<void> }>

beforeEach(() => {
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({ quiet: true, stopOnSignals: false, extensions: [persistence] })
  open = []
})

afterEach(async () => {
  for (const c of open) await c.disconnect()
  await hp.destroy?.()
})

/** The folder document: a Brand colour, and a Title style in it (plus a Body style). */
function folderDoc(): Y.Doc {
  const doc = new Y.Doc()
  addFolderToken(doc, 'colors', 'brand', { name: 'Brand', value: '#2040c0' })
  addFolderToken(doc, 'colors', 'ink', { name: 'Ink', value: '#111111' })
  addFolderToken(doc, 'textStyles', 'title', {
    name: 'Title',
    family: 'Inter',
    weight: 700,
    size: 72,
    color: { $token: 'colors.brand' },
    builtin: true,
  })
  addFolderToken(doc, 'textStyles', 'body', { name: 'Body', size: 24, color: '#333333' })
  return doc
}

/**
 * A deck (or component master) with a text box linked to Title (its size
 * set by hand), a box linked to Body, and a table whose defaults are linked
 * to Title.
 */
function deckDoc(): Y.Doc {
  const deck = createSlideDoc()
  const slideId = listSlides(deck)[0]!.id
  const objects = getSlideObjectsCtx(deck, slideId)!
  const text = (id: string, extra: Partial<TextObject>): TextObject => ({
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 400,
    height: 80,
    text: id,
    fontSize: 40,
    fontWeight: 400,
    color: 0x000000,
    align: 'left',
    rotation: 0,
    opacity: 1,
    ...extra,
  })
  addObjects(objects, [
    text('heading', { textStyleId: 'title', textStyleOverrides: ['fontSize'], fontSize: 64 }),
    text('para', { textStyleId: 'body' }),
  ])
  const tableId = addTable(objects, { x: 0, y: 300, width: 600, height: 200, rows: 2, cols: 2 })
  setTableDefaultsPatch(objects, tableId, { textStyleId: 'title' })
  return deck.doc
}

function store(kind: 'folder' | 'deck' | 'component', id: string, doc: Y.Doc): void {
  persistence.snapshots.set(documentName(kind, id), Y.encodeStateAsUpdate(doc))
}

/** Load the document into the sync server and keep it there; returns the live copy. */
async function openDoc(kind: 'folder' | 'deck' | 'component', id: string): Promise<Y.Doc> {
  const connection = await hp.openDirectConnection(documentName(kind, id))
  open.push(connection)
  return hp.documents.get(documentName(kind, id))!
}

function objectsOf(doc: Y.Doc): Array<Record<string, unknown>> {
  const slide = doc.getArray<Y.Map<unknown>>('slides').get(0)
  return (slide.get('objects') as Y.Array<Y.Map<unknown>>).toArray().map((m) => m.toJSON())
}
const byId = (doc: Y.Doc, id: string) => objectsOf(doc).find((o) => o['id'] === id)!
const tableOf = (doc: Y.Doc) => objectsOf(doc).find((o) => o['type'] === 'table')!

/** Record the origins of the updates a live document receives from now on. */
function originsOf(doc: Y.Doc): unknown[] {
  const origins: unknown[] = []
  doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
  return origins
}

function service(selects: unknown[][]) {
  const db = scriptedDb({ selects })
  return {
    tokens: createTokensService({ db: db.db, log: quietLog, hocuspocus: () => hp }),
    db,
  }
}

describe('token writes', () => {
  it('adds a token to the live folder document', async () => {
    store('folder', FOLDER, folderDoc())
    const live = await openDoc('folder', FOLDER)
    const { tokens } = service([[folderRow]])
    const { tokenId } = await tokens.create({
      userId: USER,
      folderId: FOLDER,
      category: 'colors',
      fields: { name: 'Accent', value: '#ff8800' },
    })
    expect(readFolderTokens(live).colors[tokenId]).toEqual({
      id: tokenId,
      name: 'Accent',
      value: '#ff8800',
    })
  })

  it('refuses a colour past the cap and writes nothing', async () => {
    const doc = new Y.Doc()
    for (let i = 0; i < 24; i++)
      addFolderToken(doc, 'colors', `c${i}`, { name: `C${i}`, value: '#000000' })
    store('folder', FOLDER, doc)
    const live = await openDoc('folder', FOLDER)
    const origins = originsOf(live)
    const { tokens } = service([[folderRow]])
    const err = await serviceErrorOf(
      tokens.create({
        userId: USER,
        folderId: FOLDER,
        category: 'colors',
        fields: { name: 'One more', value: '#ffffff' },
      }),
    )
    expect(err.status).toBe(409)
    expect(origins).toEqual([])
  })

  it('refuses to delete a built-in text style, deletes others', async () => {
    store('folder', FOLDER, folderDoc())
    const live = await openDoc('folder', FOLDER)
    const { tokens } = service([[folderRow], [folderRow], [folderRow]])
    const builtin = await serviceErrorOf(
      tokens.delete({ userId: USER, folderId: FOLDER, category: 'textStyles', tokenId: 'title' }),
    )
    expect(builtin.status).toBe(409)
    const missing = await serviceErrorOf(
      tokens.delete({ userId: USER, folderId: FOLDER, category: 'colors', tokenId: 'nope' }),
    )
    expect(missing.status).toBe(404)
    await tokens.delete({ userId: USER, folderId: FOLDER, category: 'textStyles', tokenId: 'body' })
    expect(readFolderTokens(live).textStyles['body']).toBeUndefined()
  })

  it('refuses a change of nothing', async () => {
    const { tokens } = service([])
    const err = await serviceErrorOf(
      tokens.update({
        userId: USER,
        folderId: FOLDER,
        category: 'colors',
        tokenId: 'brand',
        patch: {},
      }),
    )
    expect(err.status).toBe(400)
  })

  it('keeps text style names unique in the folder (they are applied by name)', async () => {
    store('folder', FOLDER, folderDoc())
    const live = await openDoc('folder', FOLDER)
    const { tokens } = service([[folderRow], [folderRow], [folderRow]])
    const taken = await serviceErrorOf(
      tokens.create({
        userId: USER,
        folderId: FOLDER,
        category: 'textStyles',
        fields: { name: ' body ' },
      }),
    )
    expect(taken.status).toBe(409)
    const rename = await serviceErrorOf(
      tokens.update({
        userId: USER,
        folderId: FOLDER,
        category: 'textStyles',
        tokenId: 'body',
        patch: { name: 'Title' },
      }),
    )
    expect(rename.status).toBe(409)
    // Its own name, differently cased, is not taken.
    await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      tokenId: 'body',
      patch: { name: 'BODY' },
    })
    expect(readFolderTokens(live).textStyles['body']?.name).toBe('BODY')
  })

  it('refuses another user', async () => {
    const { tokens } = service([[{ ...folderRow, ownerUserId: 'someone-else' }]])
    const err = await serviceErrorOf(
      tokens.create({
        userId: USER,
        folderId: FOLDER,
        category: 'colors',
        fields: { name: 'X', value: '#000000' },
      }),
    )
    expect(err.status).toBe(403)
  })
})

describe('token propagation', () => {
  it('re-styles linked text boxes and table defaults in open and closed decks and masters', async () => {
    store('folder', FOLDER, folderDoc())
    store('deck', 'd_open', deckDoc())
    store('component', 'c1', deckDoc())
    const closedDeck = deckDoc()
    store('deck', 'd_closed', closedDeck)
    await openDoc('folder', FOLDER)
    const openDeck = await openDoc('deck', 'd_open')
    const origins = originsOf(openDeck)

    const { tokens } = service([
      [folderRow],
      // The folder's decks and component masters.
      [{ id: 'd_open' }, { id: 'd_closed' }],
      [{ id: 'c1' }],
      // d_closed and c1 are not loaded: their dry runs read the stored rows.
      [{ update: Y.encodeStateAsUpdate(closedDeck) }],
      [{ update: persistence.snapshots.get('component:c1')! }],
    ])
    const { propagated } = await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      tokenId: 'title',
      patch: { size: 80, weight: 800 },
    })
    expect(propagated).toEqual({ decks: 2, components: 1, objects: 6, failed: [] })

    // The box linked to Title took the weight; its size was set by hand.
    expect(byId(openDeck, 'heading')).toMatchObject({ fontWeight: 800, fontSize: 64 })
    // The table's defaults follow Title too.
    expect(tableOf(openDeck)['defaults']).toMatchObject({ fontSize: 80, fontWeight: 800 })
    // The box linked to Body did not change.
    expect(byId(openDeck, 'para')['fontWeight']).toBe(400)
    // Mirrored from the folder: on nobody's undo stack, in no agent run.
    expect(origins.length).toBeGreaterThan(0)
    expect(origins.every((o) => o === TOKEN_PROPAGATION_ORIGIN)).toBe(true)

    // The closed deck and the master were written through the sync server too.
    const closed = new Y.Doc()
    Y.applyUpdate(closed, persistence.snapshots.get('d_closed')!)
    const master = hp.documents.get('component:c1') ?? new Y.Doc()
    if (!hp.documents.has('component:c1'))
      Y.applyUpdate(master, persistence.snapshots.get('component:c1')!)
    for (const doc of [closed, master]) {
      expect(byId(doc, 'heading')['fontWeight']).toBe(800)
      expect(tableOf(doc)['defaults']).toMatchObject({ fontSize: 80 })
    }
  })

  it('carries a colour change into the text of the styles that use it', async () => {
    store('folder', FOLDER, folderDoc())
    store('deck', 'd1', deckDoc())
    await openDoc('folder', FOLDER)
    const deck = await openDoc('deck', 'd1')
    // Ownership for the change, then for reading which styles use the colour.
    const { tokens } = service([[folderRow], [folderRow], [{ id: 'd1' }], []])
    const { propagated } = await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'colors',
      tokenId: 'brand',
      patch: { value: '#ff0000' },
    })
    // Title uses Brand: the heading box and the table defaults take its new
    // value; the box linked to Body does not.
    expect(propagated.objects).toBe(2)
    expect(byId(deck, 'heading')['color']).toBe(0xff0000)
    expect(tableOf(deck)['defaults']).toMatchObject({ color: 0xff0000 })
    expect(byId(deck, 'para')['color']).toBe(0x000000)
  })

  it('writes nothing for a change that changes nothing, and re-styles nothing for a rename', async () => {
    store('folder', FOLDER, folderDoc())
    store('deck', 'd1', deckDoc())
    const folder = await openDoc('folder', FOLDER)
    const deck = await openDoc('deck', 'd1')
    const folderWrites = originsOf(folder)
    const deckWrites = originsOf(deck)
    const { tokens } = service([[folderRow], [folderRow], [folderRow], [{ id: 'd1' }], []])
    // A rename is written, but reaches no deck.
    await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      tokenId: 'title',
      patch: { name: 'Headline' },
    })
    expect(folderWrites).toHaveLength(1)
    // Body's current size: nothing is written, nothing re-styled.
    const same = await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      tokenId: 'body',
      patch: { size: 24 },
    })
    expect(same.previous).toEqual({ size: 24 })
    expect(same.propagated.objects).toBe(0)
    expect(folderWrites).toHaveLength(1)
    expect(deckWrites).toEqual([])
    // A real change reaches the linked box once.
    const changed = await tokens.update({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      tokenId: 'body',
      patch: { size: 30 },
    })
    expect(changed.previous).toEqual({ size: 24 })
    expect(changed.propagated.objects).toBe(1)
    expect(byId(deck, 'para')['fontSize']).toBe(30)
  })

  it('merges changes made while a propagation runs into one more run', async () => {
    store('folder', FOLDER, folderDoc())
    store('deck', 'd1', deckDoc())
    await openDoc('folder', FOLDER)
    const deck = await openDoc('deck', 'd1')
    const deckWrites = originsOf(deck)
    // Three changes at once: the first run, then ONE run for the other two.
    const { tokens } = service([
      [folderRow],
      [folderRow],
      [folderRow],
      [{ id: 'd1' }],
      [],
      [{ id: 'd1' }],
      [],
    ])
    const results = await Promise.all(
      [26, 28, 32].map((size) =>
        tokens.update({
          userId: USER,
          folderId: FOLDER,
          category: 'textStyles',
          tokenId: 'body',
          patch: { size },
        }),
      ),
    )
    // The last two were carried by the same run, which read the folder afresh.
    expect(results[1]!.propagated).toBe(results[2]!.propagated)
    expect(byId(deck, 'para')['fontSize']).toBe(32)
    expect(deckWrites.length).toBeLessThanOrEqual(2)
  })

  it('refuses invalid fields and remembers who made a style', async () => {
    store('folder', FOLDER, folderDoc())
    const live = await openDoc('folder', FOLDER)
    const { tokens } = service([[folderRow]])
    const bad = await serviceErrorOf(
      tokens.update({
        userId: USER,
        folderId: FOLDER,
        category: 'textStyles',
        tokenId: 'title',
        patch: { family: 'x; } * { color: red', size: -1 },
      }),
    )
    expect(bad.status).toBe(400)
    expect(bad.body['issues']).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['family'] })]),
    )
    const { tokenId } = await tokens.create({
      userId: USER,
      folderId: FOLDER,
      category: 'textStyles',
      fields: { name: 'Caption' },
    })
    // Named like a default style, made by a person: never taken for a seed.
    expect(readFolderTokens(live).textStyles[tokenId]).not.toHaveProperty('builtin')
    expect(
      await ensureFolderTokens(
        { db: scriptedDb().db, log: quietLog, hocuspocus: () => hp },
        FOLDER,
      ),
    ).toMatchObject({ migrated: true })
    expect(readFolderTokens(live).textStyles[tokenId]?.builtin).toBeUndefined()
  })
})

describe('ensureFolderTokens', () => {
  const deps = () => ({ db: scriptedDb().db, log: quietLog, hocuspocus: () => hp })

  it('seeds a folder without tokens', async () => {
    const live = await openDoc('folder', FOLDER)
    const result = await ensureFolderTokens(deps(), FOLDER)
    expect(result).toMatchObject({ seeded: true, migrated: false })
    const tokens = readFolderTokens(live)
    expect(Object.keys(tokens.colors).length).toBeGreaterThan(0)
    expect(Object.values(tokens.textStyles).every((s) => s.builtin === true)).toBe(true)
  })

  it('brings an older seed up to date', async () => {
    const doc = new Y.Doc()
    addFolderToken(doc, 'textStyles', 'fn', { name: 'Footnote', size: 12 })
    addFolderToken(doc, 'textStyles', 'b', { name: 'Body', size: 24 })
    store('folder', FOLDER, doc)
    const live = await openDoc('folder', FOLDER)
    const result = await ensureFolderTokens(deps(), FOLDER)
    expect(result).toMatchObject({ seeded: false, migrated: true })
    expect(readFolderTokens(live).textStyles['fn']).toMatchObject({
      name: 'Footnotes and pages',
      builtin: true,
    })
    expect(readFolderTokens(live).textStyles['b']?.builtin).toBe(true)
  })

  it('writes nothing to a folder that is up to date', async () => {
    const doc = folderDoc()
    // "Body" without the flag would be migrated; this folder has it.
    updateFolderToken(doc, 'textStyles', 'body', { builtin: true })
    store('folder', FOLDER, doc)
    const live = await openDoc('folder', FOLDER)
    const origins = originsOf(live)
    const result = await ensureFolderTokens(deps(), FOLDER)
    expect(result).toMatchObject({ seeded: false, migrated: false })
    expect(origins).toEqual([])
  })
})
