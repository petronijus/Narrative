/**
 * pptx/appendDeck.test.ts
 *
 * The append pipeline's media contract, which the new-deck import had and the
 * append did not:
 *
 *   1. Every embedded video gets a transcode job. Without one its row sits in
 *      `transcode_status = 'pending'` forever and the video never plays.
 *   2. Every media row exists — and every transcode is enqueued — BEFORE the
 *      slides reach the live document. Connected editors receive the insert
 *      over the wire the moment it happens, so a row written afterwards is a
 *      window in which they render an asset the server does not know about,
 *      and a crash inside that window leaves slides pointing at nothing.
 *   3. A document write that fails leaves the rows either provably
 *      unreferenced (deleted again) or possibly referenced (kept).
 *
 * The same staging/commit helper serves the new-deck import, so it is
 * exercised through `importDeckFromPptxBytes` as well.
 *
 * MinIO, BullMQ and Hocuspocus are faked; the parser, writer and slide model
 * are real, so what lands in the document is what production would write.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'
import * as Y from 'yjs'
import { hydrateSlideDoc, listSlides } from '@narrative/slide-model'
import type { Database } from '../db/client.js'
import { decks, deckPermissions, deckUpdates, mediaAssets } from '../db/schema.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One timeline for every side effect, so ordering is asserted directly. */
const events: string[] = []

const { s3Send, enqueueVideoTranscode, getHocuspocusInstance } = vi.hoisted(() => ({
  s3Send: vi.fn(),
  enqueueVideoTranscode: vi.fn(),
  getHocuspocusInstance: vi.fn(),
}))

vi.mock('../media/s3Client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../media/s3Client.js')>()
  return { ...actual, MEDIA_BUCKET: 'test-bucket', buildS3Client: () => ({ send: s3Send }) }
})
vi.mock('../media/enqueue.js', () => ({ enqueueVideoTranscode }))
vi.mock('../hocuspocus/presence.js', () => ({ getHocuspocusInstance }))

import { appendPptxToDeck } from './appendDeck.js'
import { importDeckFromPptxBytes } from './importDeck.js'

const log = { info: vi.fn(), warn: vi.fn() }

function tableName(table: unknown): string {
  if (table === mediaAssets) return 'media_assets'
  if (table === decks) return 'decks'
  if (table === deckPermissions) return 'deck_permissions'
  if (table === deckUpdates) return 'deck_updates'
  return 'unknown'
}

interface FakeDb {
  db: Database
  /** Rows currently "committed" per table. */
  committed: Map<string, Array<Record<string, unknown>>>
  deletes: Array<{ table: string }>
}

/**
 * Just enough of Drizzle for the pipeline: `insert().values()` (with an
 * optional `.returning()`), `delete().where()`, `select()...` for the folder
 * lookup, and `transaction()` that stages writes and only commits them when
 * the callback resolves — so "the row exists" means "the transaction
 * committed", the property the ordering depends on.
 */
function makeFakeDb(opts: { folderOwner?: string } = {}): FakeDb {
  const committed = new Map<string, Array<Record<string, unknown>>>()
  const deletes: Array<{ table: string }> = []
  const commit = (staged: Array<[string, Array<Record<string, unknown>>]>): void => {
    for (const [name, rows] of staged) {
      committed.set(name, [...(committed.get(name) ?? []), ...rows])
      events.push(`commit:${name}`)
    }
  }
  const writer = (staged: Array<[string, Array<Record<string, unknown>>]> | null) => ({
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const rows = Array.isArray(v) ? v : [v]
        const name = tableName(table)
        if (staged === null) commit([[name, rows]])
        else staged.push([name, rows])
        const done = Promise.resolve(undefined)
        return Object.assign(done, { returning: async () => rows })
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        const name = tableName(table)
        deletes.push({ table: name })
        committed.set(name, [])
        events.push(`delete:${name}`)
      },
    }),
  })
  const db = {
    ...writer(null),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            opts.folderOwner !== undefined
              ? [{ id: 'folder-1', ownerUserId: opts.folderOwner }]
              : [],
        }),
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const staged: Array<[string, Array<Record<string, unknown>>]> = []
      const result = await fn(writer(staged))
      commit(staged)
      return result
    },
  }
  return { db: db as unknown as Database, committed, deletes }
}

/**
 * A live document behind a fake `openDirectConnection`. Records how many
 * media rows were committed at the moment the document was written.
 */
function makeFakeHocuspocus(
  doc: Y.Doc,
  committed: FakeDb['committed'],
  behaviour: 'ok' | 'openFails' | 'storeFails' = 'ok',
): { seenAssetRowsAtWrite: () => number | null } {
  let seen: number | null = null
  getHocuspocusInstance.mockReturnValue({
    openDirectConnection: async () => {
      if (behaviour === 'openFails') throw new Error('document failed to load')
      return {
        transact: async (fn: (d: Y.Doc) => void) => {
          seen = committed.get('media_assets')?.length ?? 0
          events.push('doc:write')
          fn(doc)
          // Hocuspocus 2.15.3 runs the store hooks AFTER the callback has
          // already mutated (and broadcast) the document, and rethrows their
          // failure — so a rejected transact can mean "the slides are there".
          if (behaviour === 'storeFails') throw new Error('onStoreDocument failed')
        },
        disconnect: async () => {
          events.push('doc:disconnect')
        },
      }
    },
  })
  return { seenAssetRowsAtWrite: () => seen }
}

// ---------------------------------------------------------------------------
// Fixture: one slide holding a video with a poster frame, plus an image.
// ---------------------------------------------------------------------------

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
// `ftyp` at offset 4 is what the parser sniffs as video/mp4.
const MP4_STUB = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
])

async function videoDeckPptx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/poster.png"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/clip.mp4"/>
</Relationships>`,
  )
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:pic>
      <p:nvPicPr>
        <p:cNvPr id="2" name="v"/>
        <p:cNvPicPr/>
        <p:nvPr><a:videoFile r:embed="rId3"/></p:nvPr>
      </p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="2438400" cy="1828800"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </p:spPr>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`,
  )
  zip.file('ppt/media/clip.mp4', MP4_STUB)
  zip.file('ppt/media/poster.png', PNG_1x1)
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

function liveDoc(): Y.Doc {
  const doc = new Y.Doc()
  hydrateSlideDoc(doc)
  return doc
}

function videoRowOf(fake: FakeDb): Record<string, unknown> {
  const row = (fake.committed.get('media_assets') ?? []).find((r) => r['kind'] === 'video')
  expect(row).toBeDefined()
  return row!
}

beforeEach(() => {
  events.length = 0
  vi.resetAllMocks()
  s3Send.mockImplementation(async () => {
    events.push('s3:send')
    return {}
  })
  enqueueVideoTranscode.mockImplementation(async (job: { assetId: string }) => {
    events.push(`enqueue:${job.assetId}`)
  })
})

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

describe('appendPptxToDeck — media rows and transcodes', () => {
  it('enqueues a transcode for every embedded video, bound to the target deck', async () => {
    const fake = makeFakeDb()
    makeFakeHocuspocus(liveDoc(), fake.committed)

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out.ok).toBe(true)
    const video = videoRowOf(fake)
    expect(video['transcodeStatus']).toBe('pending')
    expect(enqueueVideoTranscode).toHaveBeenCalledTimes(1)
    expect(enqueueVideoTranscode).toHaveBeenCalledWith({
      assetId: video['id'],
      deckId: 'deck-1',
      storageKey: video['storageKey'],
      uploaderUserId: 'user-1',
      mimeType: 'video/mp4',
    })
  })

  it('commits every media row and enqueues every transcode before the live document write', async () => {
    const fake = makeFakeDb()
    const doc = liveDoc()
    const hp = makeFakeHocuspocus(doc, fake.committed)

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })
    expect(out.ok).toBe(true)

    const commitAt = events.indexOf('commit:media_assets')
    const enqueueAt = events.findIndex((e) => e.startsWith('enqueue:'))
    const writeAt = events.indexOf('doc:write')
    expect(commitAt).toBeGreaterThanOrEqual(0)
    expect(enqueueAt).toBeGreaterThan(commitAt)
    expect(writeAt).toBeGreaterThan(enqueueAt)
    // Both rows (poster image + video) were already committed when the
    // document was written.
    expect(hp.seenAssetRowsAtWrite()).toBe(2)

    // …and the slides the document received point at exactly those rows.
    const rowIds = new Set((fake.committed.get('media_assets') ?? []).map((r) => r['id']))
    const inserted = listSlides(hydrateSlideDoc(doc)).at(-1)!
    const referenced = inserted.objects
      .map((o) => (o as { assetId?: string }).assetId)
      .filter((a): a is string => typeof a === 'string')
    expect(referenced.length).toBeGreaterThan(0)
    for (const id of referenced) expect(rowIds.has(id)).toBe(true)
  })

  it('does not fail the append when the queue is down (the rows are already safe)', async () => {
    const fake = makeFakeDb()
    makeFakeHocuspocus(liveDoc(), fake.committed)
    enqueueVideoTranscode.mockRejectedValueOnce(new Error('redis down'))

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out.ok).toBe(true)
    expect(events).toContain('doc:write')
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: videoRowOf(fake)['id'] }),
      expect.stringContaining('enqueueVideoTranscode failed'),
    )
  })

  it('removes the rows again when the document could not even be opened', async () => {
    const fake = makeFakeDb()
    makeFakeHocuspocus(liveDoc(), fake.committed, 'openFails')

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out).toEqual({ ok: false, error: { kind: 'writeFailed', documentTouched: false } })
    // Nothing can reference them, so neither the rows nor the stored bytes
    // are kept.
    expect(fake.deletes).toEqual([{ table: 'media_assets' }])
    expect(fake.committed.get('media_assets')).toEqual([])
    const deleteCall = s3Send.mock.calls.find(
      ([cmd]) =>
        (cmd as { constructor: { name: string } }).constructor.name === 'DeleteObjectsCommand',
    )
    expect(deleteCall).toBeDefined()
  })

  it('keeps the rows when the document may already hold the slides', async () => {
    const fake = makeFakeDb()
    const doc = liveDoc()
    makeFakeHocuspocus(doc, fake.committed, 'storeFails')
    const before = listSlides(hydrateSlideDoc(doc)).length

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out).toEqual({ ok: false, error: { kind: 'writeFailed', documentTouched: true } })
    // The live document did take the slides (and connected clients with it);
    // deleting their rows now would break exactly what they are rendering.
    expect(listSlides(hydrateSlideDoc(doc)).length).toBe(before + 1)
    expect(fake.deletes).toEqual([])
    expect(fake.committed.get('media_assets')).toHaveLength(2)
    expect(events).toContain('doc:disconnect')
  })

  it('without a sync server, commits rows and the deck update together, then enqueues', async () => {
    getHocuspocusInstance.mockReturnValue(null)
    const fake = makeFakeDb()
    // The detached fallback replays deck_updates; an empty history is fine.
    ;(fake.db as unknown as { select: unknown }).select = () => ({
      from: () => ({ where: () => ({ orderBy: async () => [] }) }),
    })

    const out = await appendPptxToDeck({
      bytes: await videoDeckPptx(),
      deckId: 'deck-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out.ok).toBe(true)
    expect(fake.committed.get('deck_updates')).toHaveLength(1)
    const commitRows = events.indexOf('commit:media_assets')
    const commitUpdate = events.indexOf('commit:deck_updates')
    const enqueueAt = events.findIndex((e) => e.startsWith('enqueue:'))
    expect(commitRows).toBeGreaterThanOrEqual(0)
    expect(commitUpdate).toBeGreaterThanOrEqual(0)
    expect(enqueueAt).toBeGreaterThan(Math.max(commitRows, commitUpdate))
  })
})

// ---------------------------------------------------------------------------
// Import — same helper, so the same guarantees
// ---------------------------------------------------------------------------

describe('importDeckFromPptxBytes — media rows and transcodes', () => {
  it('commits the deck and its media rows together, then enqueues the transcode', async () => {
    const fake = makeFakeDb({ folderOwner: 'user-1' })

    const out = await importDeckFromPptxBytes({
      bytes: await videoDeckPptx(),
      folderId: 'folder-1',
      ownerUserId: 'user-1',
      db: fake.db,
      log,
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const video = videoRowOf(fake)
    expect(video['deckId']).toBe(out.result.deckId)
    expect(enqueueVideoTranscode).toHaveBeenCalledWith({
      assetId: video['id'],
      deckId: out.result.deckId,
      storageKey: video['storageKey'],
      uploaderUserId: 'user-1',
      mimeType: 'video/mp4',
    })
    // The deck row the media rows reference commits in the same transaction,
    // and the job is only enqueued once all of it is durable.
    const enqueueAt = events.findIndex((e) => e.startsWith('enqueue:'))
    for (const table of ['decks', 'deck_permissions', 'media_assets', 'deck_updates']) {
      const at = events.indexOf(`commit:${table}`)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(enqueueAt).toBeGreaterThan(at)
    }
  })
})
