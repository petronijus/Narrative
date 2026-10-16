/**
 * services/deckDuplicate.test.ts — `deck.duplicate` (DecksService.duplicate):
 * the whole deck — every slide with its ids, notes and media references, and
 * the deck guides — becomes the first document state of a new deck the
 * caller owns; the media it shows is copied into the new deck's namespace
 * and registered in the same transaction as the deck row; the source is
 * never modified; a viewer cannot copy a deck out. The copy lands in the
 * source's folder when the caller is an editor there (folder sharing),
 * else in their Drafts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addGuide,
  addObjects,
  addSlide,
  getSlideNotesText,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  listDeckGuides,
  listSlides,
  setSlideNotes,
} from '@narrative/slide-model'
import type { ImageObject } from '@narrative/shared'
import { MemoryPersistence, quietLog } from '../test-support/agentWorld.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'
import { releaseHocuspocus } from '../test-support/hocuspocus.js'

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
  signImgproxyUrl: vi.fn().mockReturnValue('https://img.test/signed'),
}))
vi.mock('../auth/permissions.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/permissions.js')>()
  return { ...original, resolveDeckAccess: vi.fn() }
})

const { resolveDeckAccess } = await import('../auth/permissions.js')
const { createDecksService } = await import('./decks.js')
const accessMock = vi.mocked(resolveDeckAccess)

let hp: Hocuspocus
let persistence: MemoryPersistence

beforeEach(() => {
  send.mockClear()
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({ quiet: true, extensions: [persistence] })
  accessMock.mockResolvedValue({ role: 'editor', reason: 'direct' })
})

afterEach(async () => {
  await releaseHocuspocus(hp)
})

/** Source deck `src`: S1 (an image linking to S2, notes) and S2; one guide. */
function seedSource(): void {
  const doc = new Y.Doc()
  const deck = hydrateSlideDoc(doc)
  addSlide(deck)
  ;['S1', 'S2'].forEach((id, i) => deck.slides.get(i).set('id', id))
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
  addObjects(getSlideObjectsCtx(deck, 'S1')!, [image])
  setSlideNotes(deck, 'S1', [{ type: 'paragraph', content: [{ text: 'Say hello' }] }])
  addGuide({ doc, guides: doc.getArray('guides') }, 'vertical', 640)
  persistence.snapshots.set('src', Y.encodeStateAsUpdate(doc))
}

const mediaRow = {
  componentId: null as string | null,
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

/** A media row as copyMedia reads it: with its component's folder joined (media/visibleMedia.ts). */
const placed = <R extends object>(row: R, componentFolderId: string | null = null) => ({
  row,
  componentFolderId,
})

describe('DecksService.duplicate', () => {
  it('copies the whole deck into a new deck of the caller, media included, in one write', async () => {
    seedSource()
    const sourceEditor = await hp.openDirectConnection('src')
    const script = scriptedDb({
      selects: [
        [{ id: 'src', title: 'Pitch', folderId: 'f1', thumbnailKey: 'decks/src/thumb.png' }],
        [{ role: 'editor' }], // the caller is an editor of its folder
        [placed(mediaRow)], // assets the slides show
      ],
    })
    const service = createDecksService({ db: script.db, log: quietLog, hocuspocus: () => hp })
    const copy = await service.duplicate({ userId: 'u1', deckId: 'src' })

    expect(copy).toMatchObject({
      title: 'Pitch (copy)',
      folderId: 'f1',
      ownerUserId: 'u1',
      slideCount: 2,
      mediaCopied: 1,
      skippedImages: 0,
    })
    // The preview is copied to the new deck's key and recorded on its row.
    const copies = send.mock.calls.map(
      (c) => (c[0] as { input: { CopySource: string; Key: string } }).input,
    )
    expect(copies).toContainEqual(
      expect.objectContaining({
        CopySource: 'bucket/decks/src/thumb.png',
        Key: `decks/${copy.id}/thumb.png`,
      }),
    )
    expect(copy.thumbnailKey).toBe(`decks/${copy.id}/thumb.png`)

    const inserts = script.writes.filter((w) => w.kind === 'insert')
    expect(inserts.map((w) => w.table)).toEqual([
      'decks',
      'deck_permissions',
      'deck_updates',
      'media_assets',
    ])
    const [asset] = inserts[3]!.values as Array<{ id: string; deckId: string }>
    expect(asset!.deckId).toBe(copy.id)

    // The new deck's document: same slide ids, the image re-pointed at the
    // copied asset, its link still valid, the notes and the guide kept.
    const { update } = inserts[2]!.values as { update: Uint8Array }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, update)
    const deck = { doc, slides: doc.getArray<Y.Map<unknown>>('slides') }
    const slides = listSlides(deck)
    expect(slides.map((s) => s.id)).toEqual(['S1', 'S2'])
    const img = slides[0]!.objects[0] as ImageObject
    expect(img.assetId).toBe(asset!.id)
    expect(img.hyperlink).toEqual({ kind: 'slide', slideId: 'S2' })
    expect(getSlideNotesText(deck, 'S1')).toBe('Say hello')
    expect(listDeckGuides({ doc, guides: doc.getArray('guides') })).toHaveLength(1)

    // The source is untouched.
    const source = listSlides(hydrateSlideDoc(sourceEditor.document!))
    expect((source[0]!.objects[0] as ImageObject).assetId).toBe('a_src')
    await sourceEditor.disconnect()
  })

  // Not a member of the source folder (a deck shared on its own), or only a
  // viewer of it: the caller may not add decks there.
  for (const [who, roleRows] of [
    ['is not a member of', []],
    ['is only a viewer of', [{ role: 'viewer' }]],
  ] as const) {
    it(`puts the copy in Drafts when the caller ${who} the source folder`, async () => {
      seedSource()
      const sourceEditor = await hp.openDirectConnection('src')
      const script = scriptedDb({
        selects: [
          [{ id: 'src', title: 'Shared deck', folderId: 'theirs', thumbnailKey: null }],
          [...roleRows], // the caller's role in the source folder
          [{ id: 'drafts' }], // getOrProvisionDrafts finds the Drafts folder
          [placed(mediaRow)],
          [], // stored rows of the source folder (no tokens)…
          [], // …and of Drafts: token references are rebound across folders
        ],
      })
      const service = createDecksService({ db: script.db, log: quietLog, hocuspocus: () => hp })
      try {
        const copy = await service.duplicate({ userId: 'u1', deckId: 'src', title: 'Mine' })
        expect(copy).toMatchObject({ title: 'Mine', folderId: 'drafts' })
        expect(copy.tokens).toEqual({ rebound: 0, literalised: 0, detached: 0, unmatched: 0 })
        expect(script.remaining().selects).toBe(0)
      } finally {
        await sourceEditor.disconnect()
      }
    })
  }

  it('refuses a named target folder the caller is only a viewer of, before copying anything', async () => {
    const script = scriptedDb({
      selects: [
        [{ id: 'src', title: 'Pitch', folderId: 'f1', thumbnailKey: null }],
        [{ id: 'f2', ownerUserId: 'someone-else', name: 'Team' }],
        [{ role: 'viewer' }],
      ],
    })
    const service = createDecksService({ db: script.db, log: quietLog, hocuspocus: () => hp })
    const err = await serviceErrorOf(
      service.duplicate({ userId: 'u1', deckId: 'src', folderId: 'f2' }),
    )
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/editor role/)
    expect(send).not.toHaveBeenCalled()
    expect(script.writes).toEqual([])
  })

  it('refuses a caller who can only view the deck, before copying anything', async () => {
    accessMock.mockResolvedValue({ role: 'viewer', reason: 'direct' })
    const script = scriptedDb({
      selects: [
        [{ id: 'src', title: 'Pitch', folderId: 'f1', thumbnailKey: null }],
        [], // no role in its folder: the deck was shared on its own, as viewer
        [{ id: 'drafts' }], // so the copy would go to Drafts
      ],
    })
    const service = createDecksService({ db: script.db, log: quietLog, hocuspocus: () => hp })
    const err = await serviceErrorOf(service.duplicate({ userId: 'u1', deckId: 'src' }))
    expect(err.status).toBe(403)
    expect(send).not.toHaveBeenCalled()
    expect(script.writes).toEqual([])
  })
})
