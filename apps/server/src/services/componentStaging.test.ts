/**
 * services/componentStaging.test.ts — objects and their media moving
 * between a deck and a component master (A2.12b, linked media since folder
 * sharing step 2): promoting copies the deck's pictures into the component,
 * which owns them, and writes the master through the sync server without
 * touching the slide; stamping links the master's pictures (a deck shows
 * its folder's component media) and copies nothing, refuses a deck that has
 * left the master's folder, and — when the deck moves while the stamp is
 * written — copies the linked pictures into it afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addObjects,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  listSlides,
  writeComponentMaster,
} from '@narrative/slide-model'
import type { ImageObject, RectangleObject, SlideObject } from '@narrative/shared'
import { MemoryPersistence, quietLog } from '../test-support/agentWorld.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'

const send = vi.fn().mockResolvedValue({})
vi.mock('../media/s3Client.js', () => ({
  MEDIA_BUCKET: 'bucket',
  buildS3Client: () => ({ send }),
  presignGetUrl: vi.fn(),
}))
vi.mock('../media/enqueue.js', () => ({
  enqueueVideoTranscode: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../media/imgproxyUrl.js', () => ({
  signImgproxyUrl: ({ storageKey }: { storageKey: string }) => `https://img/${storageKey}`,
}))
// Carrying linked media into a deck that moved is localiseMedia's (its own
// tests against Postgres); here: what the stamp hands it after the write.
vi.mock('./localiseMedia.js', () => ({
  carryLinkedMediaAfterWrite: vi.fn().mockResolvedValue(undefined),
}))

const { adoptMasterMedia, promoteComponent, prepareComponentStamp, stampComponentIntoDeck } =
  await import('./componentStaging.js')
const { carryLinkedMediaAfterWrite } = await import('./localiseMedia.js')

let hp: Hocuspocus
let persistence: MemoryPersistence

beforeEach(() => {
  send.mockClear()
  vi.mocked(carryLinkedMediaAfterWrite).mockClear()
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({ quiet: true, stopOnSignals: false, extensions: [persistence] })
})

afterEach(async () => {
  await editor?.disconnect()
  editor = null
  await hp.destroy?.()
})

const image = (id: string, assetId: string): ImageObject => ({
  id,
  type: 'image',
  assetId,
  x: 100,
  y: 80,
  width: 200,
  height: 100,
  rotation: 0,
  opacity: 1,
})

const rect = (id: string, extra: Partial<RectangleObject> = {}): RectangleObject => ({
  id,
  type: 'rectangle',
  x: 320,
  y: 80,
  width: 40,
  height: 40,
  rotation: 0,
  opacity: 1,
  fill: 0,
  ...extra,
})

/**
 * Deck `deck1`: slide S1 with a picture, a linked rectangle and a
 * bystander, open in an editor (so the services read it live).
 */
async function seedDeck(): Promise<void> {
  const doc = new Y.Doc()
  const deck = hydrateSlideDoc(doc)
  deck.slides.get(0).set('id', 'S1')
  addObjects(getSlideObjectsCtx(deck, 'S1')!, [
    image('pic', 'a_deck'),
    rect('link', { hyperlink: { kind: 'slide', slideId: 'S1' }, name: 'title' }),
    rect('other', { x: 900 }),
  ])
  persistence.snapshots.set('deck1', Y.encodeStateAsUpdate(doc))
  editor = await hp.openDirectConnection('deck1')
}

let editor: Awaited<ReturnType<Hocuspocus['openDirectConnection']>> | null = null

const assetRow = (id: string, owner: { deckId?: string; componentId?: string }) => ({
  id,
  deckId: owner.deckId ?? null,
  componentId: owner.componentId ?? null,
  folderId: null,
  uploaderUserId: 'u1',
  mimeType: 'image/png',
  sizeBytes: 10,
  storageKey: `${id}:unknown:ZGVja3M`,
  originalFilename: 'logo.png',
  width: 200,
  height: 100,
  kind: 'image',
  durationSec: null,
  playbackKey: null,
  posterKey: null,
  thumbnailKey: null,
  transcodeStatus: null,
  transcodeError: null,
  fontFamily: null,
  fontWeight: null,
  fontStyle: null,
  fontPostscriptName: null,
  createdAt: new Date(),
})

/** A media row as copyMedia reads it: with its component's folder joined (media/visibleMedia.ts). */
const placed = (row: ReturnType<typeof assetRow>, componentFolderId: string | null = null) => ({
  row,
  componentFolderId,
})

/** The deck's folder, created by someone else: u1's role in it is their folder_permissions row. */
const sharedFolder = { id: 'f1', ownerUserId: 'someone-else', name: 'Client' }

function objectsOfMaster(doc: Y.Doc): SlideObject[] {
  return listSlides(hydrateSlideDoc(doc))[0]!.objects
}

describe('promoteComponent', () => {
  it('makes the master from the objects, copying their pictures into the component', async () => {
    await seedDeck()
    const script = scriptedDb({
      selects: [
        [{ folderId: 'f1' }], // the deck's folder
        [sharedFolder], // …which exists
        [{ role: 'editor' }], // …and in which the user is an editor
        [placed(assetRow('a_deck', { deckId: 'deck1' }))], // media the promoted objects show
      ],
    })
    const deps = { db: script.db, log: quietLog, hocuspocus: () => hp }
    const out = await promoteComponent(deps, {
      userId: 'u1',
      deckId: 'deck1',
      slide: 'S1',
      objects: ['pic', 'link'],
      name: '  Headline  ',
    })

    const componentId = out.component.id
    expect(out).toMatchObject({
      component: { folderId: 'f1', name: 'Headline' },
      objectCount: 2,
      mediaCopied: 1,
      skippedImages: 0,
      droppedLinks: 1,
    })

    // The component row and its media row, in that order, in one transaction.
    const inserts = script.writes.filter((w) => w.kind === 'insert')
    expect(inserts.map((w) => w.table)).toEqual(['components', 'media_assets'])
    const [media] = inserts[1]!.values as Array<Record<string, unknown>>
    expect(media).toMatchObject({ componentId, deckId: null, folderId: null })
    expect(media!['storageKey']).toMatch(
      new RegExp(`^components/${componentId}/uploads/[\\w-]+/original\\.png$`),
    )
    const copy = send.mock.calls[0]![0] as { input: { Key: string } }
    expect(copy.input.Key).toBe(media!['storageKey'])

    // The master: both objects, the picture on the component's copy, the link to a slide gone.
    const master = await hp.openDirectConnection(`component:${componentId}`)
    const objects = objectsOfMaster(master.document!)
    expect(objects.map((o) => o.id)).toEqual(['pic', 'link'])
    expect((objects[0] as ImageObject).assetId).toBe(media!['id'])
    expect(objects[1]!.hyperlink).toBeUndefined()
    expect(objects[1]!.name).toBe('title')
    await master.disconnect()

    // The slide is not changed.
    const deck = await hp.openDirectConnection('deck1')
    const slide = listSlides(hydrateSlideDoc(deck.document!))[0]!
    expect(slide.objects.map((o) => o.id)).toEqual(['pic', 'link', 'other'])
    expect((slide.objects[0] as ImageObject).assetId).toBe('a_deck')
    await deck.disconnect()
  })

  it("refuses a user who is not an editor of the deck's folder (a viewer, an outsider), before reading the deck", async () => {
    await seedDeck()
    for (const roleRows of [[{ role: 'viewer' }], []]) {
      const script = scriptedDb({ selects: [[{ folderId: 'f1' }], [sharedFolder], roleRows] })
      const err = await serviceErrorOf(
        promoteComponent(
          { db: script.db, log: quietLog, hocuspocus: () => hp },
          { userId: 'u1', deckId: 'deck1', slide: 'S1', objects: ['pic'], name: 'X' },
        ),
      )
      expect(err.status).toBe(403)
      expect(err.message).toBe(
        "Components belong to the deck's folder; adding one needs the editor role in it",
      )
      expect(script.writes).toEqual([])
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('passes a missing deck folder through as 404, not as the component refusal', async () => {
    // Only a refusal becomes the component-specific 403; any other error keeps its own answer.
    const script = scriptedDb({ selects: [[{ folderId: 'f1' }], []] })
    const err = await serviceErrorOf(
      promoteComponent(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', deckId: 'deck1', slide: 'S1', objects: ['pic'], name: 'X' },
      ),
    )
    expect(err.status).toBe(404)
    expect(err.message).toBe('Folder not found')
    expect(script.writes).toEqual([])
  })

  it('refuses a deck in no folder: components live in folders', async () => {
    const script = scriptedDb({ selects: [[{ folderId: null }]] })
    const err = await serviceErrorOf(
      promoteComponent(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', deckId: 'deck1', slide: 'S1', objects: ['pic'], name: 'X' },
      ),
    )
    expect(err.status).toBe(409)
  })

  it('refuses an object the slide does not have, writing nothing', async () => {
    await seedDeck()
    const script = scriptedDb({
      selects: [[{ folderId: 'f1' }], [sharedFolder], [{ role: 'editor' }]],
    })
    await expect(
      promoteComponent(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', deckId: 'deck1', slide: 'S1', objects: ['pic', 'ghost'], name: 'X' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(script.writes).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })
})

/** A master showing picture `a_cmp`, owned by component `cmp1`. */
function masterWithPicture() {
  const doc = new Y.Doc()
  writeComponentMaster(doc, [image('pic', 'a_cmp'), rect('title', { name: 'title' })], [])
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return {
    component: {
      id: 'cmp1',
      folderId: 'f1',
      name: 'Headline',
      thumbnailKey: null,
      thumbnailUrl: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-09-30T00:00:00.000Z',
    },
    state,
  }
}

describe('prepareComponentStamp + stampComponentIntoDeck', () => {
  it("links the master's pictures in the deck — nothing copied — and stamps onto the slide", async () => {
    // A stamp stays within the component's folder, where the deck may show
    // the master's own pictures (media/visibleMedia.ts): no copy, no row.
    await seedDeck()
    const script = scriptedDb({
      selects: [
        [{ folderId: 'f1' }], // the deck's folder, read when the stamp is staged
        [placed(assetRow('a_cmp', { componentId: 'cmp1' }), 'f1')],
      ],
    })
    const deps = { db: script.db, log: quietLog, hocuspocus: () => hp }
    const prepared = await prepareComponentStamp(deps, {
      userId: 'u1',
      componentId: 'cmp1',
      deckId: 'deck1',
      master: masterWithPicture(),
    })
    expect(prepared).toMatchObject({ mediaRegistered: 0, skippedImages: 0 })
    expect(script.writes.filter((w) => w.table === 'media_assets')).toEqual([])
    expect(send).not.toHaveBeenCalled()

    const out = await stampComponentIntoDeck(deps, {
      deckId: 'deck1',
      componentId: 'cmp1',
      slideId: 'S1',
      prepare: async () => prepared,
    })
    expect(out.at).toEqual({ x: 100, y: 80 })
    const deck = await hp.openDirectConnection('deck1')
    const slide = listSlides(hydrateSlideDoc(deck.document!))[0]!
    const stamped = slide.objects.filter((o) => out.objectIds.includes(o.id))
    expect(stamped).toHaveLength(2)
    expect((stamped.find((o) => o.type === 'image') as ImageObject).assetId).toBe('a_cmp')
    await deck.disconnect()
    expect(script.remaining().selects).toBe(0)
    // Settled once, after the write: the linked picture and the folder it
    // was staged for (a deck that moved meanwhile gets it carried along).
    expect(carryLinkedMediaAfterWrite).toHaveBeenCalledExactlyOnceWith(deps, {
      userId: 'u1',
      deckId: 'deck1',
      assetIds: new Set(['a_cmp']),
      stagedFolderId: 'f1',
      what: 'stamp of component cmp1',
    })
  })

  it('refuses (409) a deck that has left the master’s folder before the stamp is staged', async () => {
    await seedDeck()
    const script = scriptedDb({ selects: [[{ folderId: 'f2' }]] })
    const err = await serviceErrorOf(
      prepareComponentStamp(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', componentId: 'cmp1', deckId: 'deck1', master: masterWithPicture() },
      ),
    )
    expect(err.status).toBe(409)
    expect(script.writes).toEqual([])
  })

  it('settles once, and never when the stamp was not written', async () => {
    await seedDeck()
    const script = scriptedDb({
      selects: [[{ folderId: 'f1' }], [placed(assetRow('a_cmp', { componentId: 'cmp1' }), 'f1')]],
    })
    const deps = { db: script.db, log: quietLog, hocuspocus: () => hp }
    const prepared = await prepareComponentStamp(deps, {
      userId: 'u1',
      componentId: 'cmp1',
      deckId: 'deck1',
      master: masterWithPicture(),
    })
    // A slide the deck no longer has: the write refuses before touching it.
    await expect(
      stampComponentIntoDeck(deps, {
        deckId: 'deck1',
        componentId: 'cmp1',
        slideId: 'S1',
        prepare: async () => {
          const doc = await hp.openDirectConnection('deck1')
          await doc.transact((d) => hydrateSlideDoc(d).slides.get(0).set('id', 'renamed'))
          await doc.disconnect()
          return prepared
        },
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(carryLinkedMediaAfterWrite).not.toHaveBeenCalled()
    await prepared.settle()
    await prepared.settle()
    expect(carryLinkedMediaAfterWrite).toHaveBeenCalledTimes(1)
  })

  it('checks the slide before copying anything: a stale slide costs no copy', async () => {
    await seedDeck()
    const prepare = vi.fn()
    await expect(
      stampComponentIntoDeck(
        { db: scriptedDb().db, log: quietLog, hocuspocus: () => hp },
        { deckId: 'deck1', componentId: 'cmp1', slideId: 'no-such-slide', prepare },
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(prepare).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('writes nothing when the slide goes before the deck is written', async () => {
    await seedDeck()
    const script = scriptedDb({
      selects: [[{ folderId: 'f1' }], [placed(assetRow('a_cmp', { componentId: 'cmp1' }), 'f1')]],
    })
    const deps = { db: script.db, log: quietLog, hocuspocus: () => hp }
    await expect(
      stampComponentIntoDeck(deps, {
        deckId: 'deck1',
        componentId: 'cmp1',
        slideId: 'S1',
        prepare: async () => {
          const prepared = await prepareComponentStamp(deps, {
            userId: 'u1',
            componentId: 'cmp1',
            deckId: 'deck1',
            master: masterWithPicture(),
          })
          // A collaborator deletes the slide while the stamp is prepared.
          await editor!.transact((doc) => hydrateSlideDoc(doc).slides.delete(0, 1))
          return prepared
        },
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    expect(script.writes).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves a picture the component does not own unresolved, and counts it', async () => {
    await seedDeck()
    const script = scriptedDb({ selects: [[{ folderId: 'f1' }], []] })
    const prepared = await prepareComponentStamp(
      { db: script.db, log: quietLog, hocuspocus: () => hp },
      { userId: 'u1', componentId: 'cmp1', deckId: 'deck1', master: masterWithPicture() },
    )
    expect(prepared).toMatchObject({ mediaRegistered: 0, skippedImages: 1 })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('adoptMasterMedia (data migration 2026-09-30-component-media)', () => {
  it("copies the folder's deck media an older master shows into its component, once", async () => {
    const doc = new Y.Doc()
    writeComponentMaster(
      doc,
      [
        image('old', 'a_deck'),
        image('own', 'a_own'),
        image('gone', 'a_gone'),
        image('foreign', 'a_foreign'),
      ],
      [],
    )
    persistence.snapshots.set('component:cmp1', Y.encodeStateAsUpdate(doc))
    const master = await hp.openDirectConnection('component:cmp1')

    const script = scriptedDb({
      selects: [
        [{ userId: 'u1', folderId: 'f1' }], // the folder owner
        [
          { id: 'a_deck', deckId: 'deck1', componentId: null, deckFolderId: 'f1' },
          { id: 'a_own', deckId: null, componentId: 'cmp1', deckFolderId: null },
          // Someone else's deck: never copied, whatever the master says.
          { id: 'a_foreign', deckId: 'deckX', componentId: null, deckFolderId: 'f9' },
        ],
        [placed(assetRow('a_deck', { deckId: 'deck1' }))], // copyMedia's read of deck1's asset
      ],
    })
    const deps = { db: script.db, log: quietLog, hocuspocus: () => hp }
    expect(await adoptMasterMedia(deps, 'cmp1')).toEqual({ copied: 1, unresolved: 2 })

    const inserted = script.writes.find((w) => w.table === 'media_assets')!.values as Array<
      Record<string, unknown>
    >
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ componentId: 'cmp1', deckId: null, uploaderUserId: 'u1' })
    const objects = objectsOfMaster(master.document!) as ImageObject[]
    expect(objects.map((o) => o.assetId)).toEqual([
      inserted[0]!['id'],
      'a_own',
      'a_gone',
      'a_foreign',
    ])

    // A second run finds nothing left to adopt and writes nothing.
    const again = scriptedDb({
      selects: [
        [{ userId: 'u1', folderId: 'f1' }],
        [
          { id: inserted[0]!['id'], deckId: null, componentId: 'cmp1', deckFolderId: null },
          { id: 'a_own', deckId: null, componentId: 'cmp1', deckFolderId: null },
          { id: 'a_foreign', deckId: 'deckX', componentId: null, deckFolderId: 'f9' },
        ],
      ],
    })
    expect(
      await adoptMasterMedia({ db: again.db, log: quietLog, hocuspocus: () => hp }, 'cmp1'),
    ).toEqual({ copied: 0, unresolved: 2 })
    expect(again.writes).toEqual([])
    await master.disconnect()
  })
})
