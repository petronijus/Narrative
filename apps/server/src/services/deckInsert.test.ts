/**
 * services/deckInsert.test.ts — `deck.insertFrom` with a deck source:
 * slides are copied with their objects, animations and notes; referenced
 * media is copied into the target deck's namespace and re-pointed; slide
 * links follow the copies or are dropped; the source is never modified; the
 * write is one synchronous step against the target document.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addObjects,
  addSlide,
  createSlideDoc,
  getSlideNotesFragment,
  getSlideNotesText,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  listSlides,
} from '@narrative/slide-model'
import type { ImageObject, RectangleObject } from '@narrative/shared'
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
vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return { ...original, resolveDeckAccess: vi.fn() }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { stageDeckInsert } = await import('./deckInsert.js')
const accessMock = vi.mocked(resolveDeckAccess)

let hp: Hocuspocus
let persistence: MemoryPersistence

beforeEach(() => {
  send.mockClear()
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({ quiet: true, stopOnSignals: false, extensions: [persistence] })
  accessMock.mockResolvedValue({ role: 'editor', reason: 'direct' })
})

afterEach(async () => {
  await hp.destroy?.()
})

/** Source deck: slides S1..S3. S1 holds an image and links to S2 and S3, and has notes. */
function seedSource(): void {
  const doc = new Y.Doc()
  const deck = hydrateSlideDoc(doc)
  addSlide(deck)
  addSlide(deck)
  ;['S1', 'S2', 'S3'].forEach((id, i) => deck.slides.get(i).set('id', id))
  const image: ImageObject = {
    id: 'img',
    type: 'image',
    assetId: 'a_src',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    hyperlink: { kind: 'slide', slideId: 'S2' },
  }
  const toS3: RectangleObject = {
    id: 'link3',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    fill: 0,
    hyperlink: { kind: 'slide', slideId: 'S3' },
  }
  addObjects(getSlideObjectsCtx(deck, 'S1')!, [image, toS3])
  const notes = getSlideNotesFragment(deck, 'S1')!
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText('Say hello')])
  notes.insert(0, [paragraph])
  persistence.snapshots.set('src', Y.encodeStateAsUpdate(doc))
}

const mediaRow = {
  id: 'a_src',
  deckId: 'src',
  folderId: null,
  uploaderUserId: 'someone',
  mimeType: 'image/png',
  sizeBytes: 10,
  storageKey: 'a_src:src:ZGVja3Mvc3Jj',
  originalFilename: 'logo.png',
  width: 100,
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
}

describe('stageDeckInsert', () => {
  it('copies the slide range with notes, media and links into the target in one write', async () => {
    seedSource()
    // The source is open in an editor, so it is read live.
    const sourceEditor = await hp.openDirectConnection('src')
    const script = scriptedDb({
      selects: [
        [
          { id: 'src', folderId: 'f1' },
          { id: 'dst', folderId: 'f1' },
        ],
        [mediaRow], // referenced assets of the source deck
      ],
    })
    const prepared = await stageDeckInsert(
      { db: script.db, log: quietLog, hocuspocus: () => hp },
      { userId: 'u1', sourceDeckId: 'src', targetDeckId: 'dst', range: { from: 0, to: 1 } },
    )
    expect(prepared.slideCount).toBe(2)

    // The media row for the target was committed BEFORE anything was written to the target.
    const inserted = script.writes.filter((w) => w.kind === 'insert' && w.table === 'media_assets')
    expect(inserted).toHaveLength(1)
    const [row] = inserted[0]!.values as Array<{ id: string; deckId: string; storageKey: string }>
    expect(row).toMatchObject({ deckId: 'dst' })
    expect(row!.storageKey).toMatch(/^decks\/dst\/uploads\/[\w-]+\/original\.png$/)
    const copy = send.mock.calls[0]![0] as { input: { CopySource: string; Key: string } }
    expect(copy.input.CopySource).toBe('bucket/a_src%3Asrc%3AZGVja3Mvc3Jj')
    expect(copy.input.Key).toBe(row!.storageKey)

    const target = createSlideDoc()
    addSlide(target)
    ;['T1', 'T2'].forEach((id, i) => target.slides.get(i).set('id', id))
    let result
    target.doc.transact(() => {
      result = prepared.apply(target, 1)
    })
    const out = result as unknown as {
      slideIds: string[]
      insertedAt: number
      droppedLinks: number
    }
    expect(out.insertedAt).toBe(1)
    expect(out.droppedLinks).toBe(1)
    const slides = listSlides(target)
    expect(slides.map((s) => s.id)).toEqual(['T1', ...out.slideIds, 'T2'])

    const [copied1, copied2] = out.slideIds
    const objects = slides[1]!.objects
    const img = objects.find((o) => o.id === 'img') as ImageObject
    expect(img.assetId).toBe(row!.id)
    expect(img.hyperlink).toEqual({ kind: 'slide', slideId: copied2 })
    expect(objects.find((o) => o.id === 'link3')!.hyperlink).toBeUndefined()
    expect(getSlideNotesText(target, copied1!)).toBe('Say hello')

    // The source deck is untouched.
    const source = listSlides(hydrateSlideDoc(sourceEditor.document!))
    expect((source[0]!.objects[0] as ImageObject).assetId).toBe('a_src')
    expect(source[0]!.objects[1]!.hyperlink).toEqual({ kind: 'slide', slideId: 'S3' })
    await sourceEditor.disconnect()
  })

  it('treats a deck the caller cannot read as missing, before reading anything', async () => {
    accessMock.mockResolvedValue(null)
    const script = scriptedDb()
    const err = await serviceErrorOf(
      stageDeckInsert(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', sourceDeckId: 'secret', targetDeckId: 'dst' },
      ),
    )
    expect(err.status).toBe(404)
    expect(script.remaining().selects).toBe(0)
  })

  it('needs editor access to the source, like exporting it: a viewer is refused', async () => {
    accessMock.mockResolvedValue({ role: 'viewer', reason: 'direct' })
    const script = scriptedDb()
    const err = await serviceErrorOf(
      stageDeckInsert(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', sourceDeckId: 'shared', targetDeckId: 'dst' },
      ),
    )
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
    expect(script.remaining().selects).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('copies exactly the chosen slides, in source order, fitting their outline levels', async () => {
    seedSource()
    const sourceEditor = await hp.openDirectConnection('src')
    await sourceEditor.transact((doc) => {
      const slides = hydrateSlideDoc(doc).slides
      slides.get(1).set('indent', 1)
      slides.get(2).set('indent', 2)
    })
    const script = scriptedDb({
      selects: [
        [
          { id: 'src', folderId: 'f1' },
          { id: 'dst', folderId: 'f1' },
        ],
      ],
    })
    const prepared = await stageDeckInsert(
      { db: script.db, log: quietLog, hocuspocus: () => hp },
      { userId: 'u1', sourceDeckId: 'src', targetDeckId: 'dst', slideIds: ['S3', 'S2'] },
    )
    expect(prepared.slideCount).toBe(2)
    // Neither slide shows media: nothing to copy.
    expect(send).not.toHaveBeenCalled()

    const target = createSlideDoc()
    addSlide(target)
    let result
    target.doc.transact(() => {
      result = prepared.apply(target, 0)
    })
    const out = result as unknown as { slideIds: string[] }
    const slides = listSlides(target)
    expect(slides.map((s) => s.id).slice(0, 2)).toEqual(out.slideIds)
    // S2 (level 1) then S3 (level 2), shifted so the first is a top-level
    // slide; the target's own two slides follow.
    expect(slides.map((s) => s.indent ?? 0)).toEqual([0, 1, 0, 0])
    await sourceEditor.disconnect()
  })

  it('answers "not found" for a chosen slide the source deck does not have', async () => {
    seedSource()
    const sourceEditor = await hp.openDirectConnection('src')
    const script = scriptedDb({
      selects: [
        [
          { id: 'src', folderId: 'f1' },
          { id: 'dst', folderId: 'f1' },
        ],
      ],
    })
    const err = await serviceErrorOf(
      stageDeckInsert(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', sourceDeckId: 'src', targetDeckId: 'dst', slideIds: ['S1', 'gone'] },
      ),
    )
    expect(err.status).toBe(404)
    expect(err.message).toContain("'gone'")
    expect(script.writes).toEqual([])
    await sourceEditor.disconnect()
  })

  it('rejects a range outside the source deck without registering media', async () => {
    seedSource()
    const script = scriptedDb({
      selects: [
        [
          { id: 'src', folderId: 'f1' },
          { id: 'dst', folderId: 'f1' },
        ],
        [{ update: persistence.snapshots.get('src')! }], // stored source
      ],
    })
    const err = await serviceErrorOf(
      stageDeckInsert(
        { db: script.db, log: quietLog, hocuspocus: () => hp },
        { userId: 'u1', sourceDeckId: 'src', targetDeckId: 'dst', range: { from: 2, to: 5 } },
      ),
    )
    expect(err.status).toBe(400)
    expect(err.message).toContain('3 slides')
    expect(script.writes).toEqual([])
  })
})
