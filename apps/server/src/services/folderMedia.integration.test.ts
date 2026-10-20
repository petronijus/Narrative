/**
 * services/folderMedia.integration.test.ts — the review fixes of folder
 * sharing step 2 (linked component media) against a real Postgres and MinIO:
 *
 *   - storage sweeps keep every file a remaining media row names (a pre-0009
 *     folder font under the deck it was uploaded in survives the deck);
 *   - a deleted component's prefix keeps its handed-over media and loses the
 *     rest; a folder's deletion sweeps the prefixes of components deleted
 *     earlier;
 *   - a sweep keeps a video's outputs the worker wrote before its row names
 *     them, and anything younger than the grace window;
 *   - moving a deck copies the media it links (pictures, a transcoded video
 *     with its outputs) through the real localisation, records each asset
 *     with its copy, and stops before moving anything when a copy fails;
 *   - references an undo brings back are re-pointed at the recorded copies
 *     (undo/redo cycles copy nothing), an id the move did not record is
 *     never copied, a lost copy is made once more at most — on the mover's
 *     budget and read access, never transcoding — and a store and a revert
 *     racing each other copy once (N1);
 *   - a stamp staged before a move and written after it carries what it
 *     linked into the deck (the real stamp, move, settle and copy; N2);
 *   - whoever may read a folder's linked media carries it into another
 *     folder as a copy — a deck-only guest included, a cut included — and
 *     nobody else (D1);
 *   - a folder's own picture is deleted through the folder target, and a
 *     deleted folder font's file goes only when no clone names it (N4);
 *   - the PowerPoint export embeds the linked picture the deck shows and
 *     nothing it merely names.
 *
 * Excluded from `pnpm test`; run with `just integration` (the docker services
 * up). It creates its own users, folders, decks and components under random
 * ids and removes them, and the files it stored, afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import JSZip from 'jszip'
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import {
  addSlide,
  createSlideDoc,
  getSlideObjectsCtx,
  hydrateSlideDoc,
  LOCAL_ORIGIN,
  writeComponentMaster,
} from '@narrative/slide-model'
import type { SlideObject } from '@narrative/shared'
import { db, pool } from '../db/client.js'
import {
  components,
  deckMovedMedia,
  deckPermissions,
  decks,
  folderPermissions,
  folders,
  mediaAssets,
  users,
} from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { quietLog } from '../test-support/agentWorld.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'
import { copyMedia, insertObjectsFrom, referencedAssets, stageDeckInsert } from './deckInsert.js'
import {
  checkMovedMediaAfterStore,
  localisationsSettled,
  repointMovedMedia,
} from './localiseMedia.js'
import { MEDIA_COPY_RATE_LIMIT, spendMediaCopyBudget } from './mediaCopyBudget.js'
import { createComponentsService } from './components.js'
import { stampComponentIntoDeck } from './componentStaging.js'
import { createDecksService } from './decks.js'
import { createFoldersService } from './folders.js'
import { createMediaService } from './media.js'
import { readDocCopy, writeLiveDoc } from './liveDocs.js'
import { exportDeckToPptx } from '../pptx/exportDeck.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-fm-${name}-${suffix}`

const owner = id('owner')
const guest = id('guest')
/** An editor of F and G with no grant on F's decks: their read access to F is the folder role alone. */
const spender = id('spender')
/** No access to anything. */
const stranger = id('stranger')
const F = id('f')
const G = id('g')
const H = id('h')
const K = id('k')
/** A folder without decks. */
const L = id('l')
const cmp = id('cmp')
const cmpH = id('cmp-h')
const cmpStamp = id('cmp-stamp')

const deps = { db, log: quietLog, hocuspocus: () => null }
const s3 = buildS3Client()

/** A real 1×1 PNG: the export embeds what it reads. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** Every deck the tests create (duplicates included), for the cleanup. */
const createdDecks = new Set<string>()
/** Every key the tests stored themselves. */
const putKeys = new Set<string>()

async function put(key: string, body: Buffer = PNG): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Body: body }))
  putKeys.add(key)
}

async function stored(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function newDeck(
  name: string,
  folderId: string,
  grants: Array<[string, 'owner' | 'editor']> = [],
) {
  const deckId = id(name)
  await db.insert(decks).values({ id: deckId, title: name, ownerUserId: owner, folderId })
  createdDecks.add(deckId)
  await db
    .insert(deckPermissions)
    .values(
      [[owner, 'owner'] as const, ...grants].map(([userId, role]) => ({ deckId, userId, role })),
    )
  return deckId
}

type Owner = { deckId: string } | { componentId: string } | { folderId: string }

/** A media row (and, unless `missing`, its stored file) of `owner`. */
async function media(
  owner_: Owner,
  opts: { kind?: 'image' | 'video' | 'font'; missing?: boolean; key?: string } = {},
): Promise<{ id: string; storageKey: string }> {
  const assetId = nanoid(12)
  const kind = opts.kind ?? 'image'
  const prefix =
    'deckId' in owner_
      ? `decks/${owner_.deckId}`
      : 'componentId' in owner_
        ? `components/${owner_.componentId}`
        : `fonts/${owner_.folderId}`
  const storageKey =
    opts.key ??
    `${prefix}/${kind === 'font' ? 'fonts' : 'uploads'}/${assetId}/original.${kind === 'video' ? 'mp4' : kind === 'font' ? 'ttf' : 'png'}`
  if (opts.missing !== true) await put(storageKey)
  const outputs =
    kind === 'video'
      ? {
          transcodeStatus: 'done' as const,
          playbackKey: `${prefix}/videos/${assetId}/playback.mp4`,
          posterKey: `${prefix}/videos/${assetId}/poster.jpg`,
          thumbnailKey: `${prefix}/videos/${assetId}/thumb.jpg`,
        }
      : {}
  for (const key of [outputs.playbackKey, outputs.posterKey, outputs.thumbnailKey]) {
    if (key !== undefined) await put(key)
  }
  await db.insert(mediaAssets).values({
    id: assetId,
    deckId: 'deckId' in owner_ ? owner_.deckId : null,
    componentId: 'componentId' in owner_ ? owner_.componentId : null,
    folderId: 'folderId' in owner_ ? owner_.folderId : null,
    uploaderUserId: owner,
    mimeType: kind === 'video' ? 'video/mp4' : kind === 'font' ? 'font/ttf' : 'image/png',
    sizeBytes: PNG.byteLength,
    storageKey,
    kind,
    ...(kind === 'font'
      ? {
          fontFamily: 'Brand Sans',
          fontWeight: 400,
          fontStyle: 'normal',
          fontPostscriptName: `Brand-${assetId}`,
        }
      : {}),
    ...outputs,
  })
  return { id: assetId, storageKey }
}

/** Put an image (or a video) showing `assetId` on the deck's first slide. */
async function show(deckId: string, assetId: string, type: 'image' | 'video' = 'image') {
  await writeLiveDoc(
    deps,
    'deck',
    deckId,
    (doc) => {
      const handles = hydrateSlideDoc(doc)
      if (handles.slides.length === 0) addSlide(handles)
      const slideId = handles.slides.get(0).get('id') as string
      getSlideObjectsCtx(handles, slideId)!.objects.push([
        new Y.Map<unknown>(
          Object.entries({
            id: nanoid(8),
            type,
            assetId,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
          }),
        ),
      ])
    },
    LOCAL_ORIGIN,
  )
}

async function shownBy(deckId: string): Promise<Set<string>> {
  const doc = await readDocCopy(deps, 'deck', deckId)
  try {
    return referencedAssets(doc.getArray<Y.Map<unknown>>('slides').toArray())
  } finally {
    doc.destroy()
  }
}

async function rowsOf(deckId: string) {
  return db.select().from(mediaAssets).where(eq(mediaAssets.deckId, deckId))
}

/** What a move (or a settle) recorded for the deck: each linked asset and its copy. */
async function movedPairs(deckId: string) {
  return db.select().from(deckMovedMedia).where(eq(deckMovedMedia.deckId, deckId))
}

/** Give the deck an empty slide; its id. */
async function emptySlide(deckId: string): Promise<string> {
  return writeLiveDoc(
    deps,
    'deck',
    deckId,
    (doc) => {
      const handles = hydrateSlideDoc(doc)
      if (handles.slides.length === 0) addSlide(handles)
      return addSlide(handles).id
    },
    LOCAL_ORIGIN,
  )
}

/** Remove everything stored under `prefix` (cleanup only). */
async function sweep(prefix: string): Promise<void> {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: MEDIA_BUCKET, Prefix: prefix }))
  const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => k !== undefined)
  if (keys.length > 0) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: MEDIA_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }
}

/** The sweep grace window this file runs with (restored afterwards). */
const graceBefore = process.env['MEDIA_SWEEP_GRACE_MS']

beforeAll(async () => {
  // Every file here was just written: sweep without a grace window, except
  // where a test sets one (media/bucketCleanup.ts).
  process.env['MEDIA_SWEEP_GRACE_MS'] = '0'
  await db.insert(users).values([
    { sub: owner, email: `${owner}@example.test`, name: 'Owner' },
    { sub: guest, email: `${guest}@example.test`, name: 'Guest' },
    { sub: spender, email: `${spender}@example.test`, name: 'Spender' },
    { sub: stranger, email: `${stranger}@example.test`, name: 'Stranger' },
  ])
  await db.insert(folders).values([
    { id: F, ownerUserId: owner, name: 'F' },
    { id: G, ownerUserId: owner, name: 'G' },
    { id: H, ownerUserId: guest, name: 'H' },
    { id: K, ownerUserId: owner, name: 'K' },
    { id: L, ownerUserId: owner, name: 'L' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: F, userId: owner, role: 'owner' },
    { folderId: G, userId: owner, role: 'owner' },
    { folderId: K, userId: owner, role: 'owner' },
    { folderId: L, userId: owner, role: 'owner' },
    { folderId: H, userId: guest, role: 'owner' },
    { folderId: F, userId: spender, role: 'editor' },
    { folderId: G, userId: spender, role: 'editor' },
  ])
  await db.insert(components).values([
    { id: cmp, folderId: F, name: 'Logo' },
    { id: cmpH, folderId: H, name: 'Other folder' },
    { id: cmpStamp, folderId: F, name: 'Stamped logo' },
  ])
})

afterAll(async () => {
  const ids = [...createdDecks]
  const all = await db
    .select({ id: decks.id })
    .from(decks)
    .where(inArray(decks.ownerUserId, [owner, guest]))
  for (const d of all) ids.push(d.id)
  const compIds = (
    await db
      .select({ id: components.id })
      .from(components)
      .where(inArray(components.folderId, [F, G, H, K, L]))
  ).map((c) => c.id)
  for (const d of new Set(ids)) await sweep(`decks/${d}/`)
  for (const c of new Set([...compIds, cmp, cmpH, cmpStamp])) await sweep(`components/${c}/`)
  const keys = [...putKeys]
  for (let i = 0; i < keys.length; i += 500) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: MEDIA_BUCKET,
        Delete: { Objects: keys.slice(i, i + 500).map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }
  await db.delete(decks).where(inArray(decks.ownerUserId, [owner, guest]))
  await db.delete(folders).where(inArray(folders.id, [F, G, H, K, L]))
  await db.delete(users).where(inArray(users.sub, [owner, guest, spender, stranger]))
  if (graceBefore === undefined) delete process.env['MEDIA_SWEEP_GRACE_MS']
  else process.env['MEDIA_SWEEP_GRACE_MS'] = graceBefore
  await pool.end()
})

describe('storage sweeps keep what a row still names (H1)', () => {
  it('keeps a pre-0009 folder font stored under its origin deck when that deck goes', async () => {
    const origin = await newDeck('font-origin', F)
    // Uploaded before migration 0009 under the deck; the folder owns the row.
    const font = await media(
      { folderId: F },
      {
        kind: 'font',
        key: `decks/${origin}/fonts/${nanoid(10)}/original.ttf`,
      },
    )
    const own = await media({ deckId: origin })
    await put(`decks/${origin}/thumb.jpg`)

    await createDecksService(deps).delete({ deckId: origin })

    expect(await stored(font.storageKey)).toBe(true)
    expect(await stored(own.storageKey)).toBe(false)
    expect(await stored(`decks/${origin}/thumb.jpg`)).toBe(false)
  })
})

describe('component and folder deletes sweep the component prefixes (item 8)', () => {
  it("keeps a deleted component's handed-over media and removes the rest of its prefix", async () => {
    const doomed = id('cmp-doomed')
    await db.insert(components).values({
      id: doomed,
      folderId: F,
      name: 'Going',
      thumbnailKey: `components/${doomed}/thumb.jpg`,
    })
    await put(`components/${doomed}/thumb.jpg`)
    const picture = await media({ componentId: doomed })
    // What a video deleted earlier left behind: no row names it.
    await put(`components/${doomed}/videos/gone/poster.jpg`)

    await createComponentsService(deps).delete({ userId: owner, componentId: doomed })

    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, picture.id))
    expect(row).toMatchObject({ componentId: null, folderId: F })
    expect(await stored(picture.storageKey)).toBe(true)
    expect(await stored(`components/${doomed}/thumb.jpg`)).toBe(false)
    expect(await stored(`components/${doomed}/videos/gone/poster.jpg`)).toBe(false)
  })

  it("keeps a video's outputs the worker wrote before its row names them (transcode race)", async () => {
    const racer = id('cmp-racer')
    await db.insert(components).values({ id: racer, folderId: F, name: 'Racer' })
    const clip = await media({ componentId: racer })
    await db
      .update(mediaAssets)
      .set({ kind: 'video', mimeType: 'video/mp4', transcodeStatus: 'processing' })
      .where(eq(mediaAssets.id, clip.id))
    // The worker uploaded its outputs; the row does not name them yet.
    const outputs = [
      `components/${racer}/videos/${clip.id}/playback.mp4`,
      `components/${racer}/videos/${clip.id}/poster.jpg`,
    ]
    for (const key of outputs) await put(key)
    await put(`components/${racer}/videos/no-such-row/poster.jpg`)

    await createComponentsService(deps).delete({ userId: owner, componentId: racer })

    for (const key of outputs) expect(await stored(key)).toBe(true)
    expect(await stored(`components/${racer}/videos/no-such-row/poster.jpg`)).toBe(false)
  })

  it('keeps anything younger than the grace window', async () => {
    const young = id('cmp-young')
    await db.insert(components).values({ id: young, folderId: F, name: 'Young' })
    await put(`components/${young}/leftover.bin`)
    process.env['MEDIA_SWEEP_GRACE_MS'] = String(15 * 60_000)
    try {
      await createComponentsService(deps).delete({ userId: owner, componentId: young })
    } finally {
      process.env['MEDIA_SWEEP_GRACE_MS'] = '0'
    }
    expect(await stored(`components/${young}/leftover.bin`)).toBe(true)
  })

  it('removes, with the folder, the files of a component deleted earlier', async () => {
    const earlier = id('cmp-earlier')
    await db.insert(components).values({ id: earlier, folderId: K, name: 'Earlier' })
    const picture = await media({ componentId: earlier })
    const video = await media({ componentId: earlier }, { kind: 'video' })
    await put(`components/${earlier}/leftover.bin`)
    await createComponentsService(deps).delete({ userId: owner, componentId: earlier })
    expect(await stored(picture.storageKey)).toBe(true)

    await createFoldersService(deps).delete({ userId: owner, folderId: K })

    expect(await stored(picture.storageKey)).toBe(false)
    expect(await stored(video.storageKey)).toBe(false)
    expect(await stored(`components/${earlier}/videos/${video.id}/poster.jpg`)).toBe(false)
    expect(await stored(`components/${earlier}/leftover.bin`)).toBe(false)
  })
})

describe('moving a deck takes its linked media along (items 5, 11)', () => {
  let moving: string
  let picture: { id: string; storageKey: string }
  let video: { id: string; storageKey: string }
  /** The copy the move made of `picture`. */
  let pictureCopy: string

  it('copies linked pictures and a transcoded video with its outputs, and records each pair', async () => {
    moving = await newDeck('moving', F)
    picture = await media({ componentId: cmp })
    const folderPicture = await media({ folderId: F })
    video = await media({ componentId: cmp }, { kind: 'video' })
    const font = await media({ folderId: F }, { kind: 'font' })
    const foreign = await media({ componentId: cmpH })
    await show(moving, picture.id)
    await show(moving, folderPicture.id)
    await show(moving, video.id, 'video')
    await show(moving, font.id) // not linkable media: stays as it was
    await show(moving, foreign.id) // another folder's: stays as it was

    const result = await createDecksService(deps).moveDecks({
      userId: owner,
      sourceFolderId: F,
      deckIds: [moving],
      destFolderId: G,
    })

    expect(result.movedCount).toBe(1)
    expect(result.media).toEqual([{ deckId: moving, copied: 3, unresolved: 2, copyFailed: 0 }])
    const [deck] = await db.select().from(decks).where(eq(decks.id, moving))
    expect(deck!.folderId).toBe(G)

    const copies = await rowsOf(moving)
    expect(copies).toHaveLength(3)
    const shown = await shownBy(moving)
    for (const copy of copies) {
      expect(shown.has(copy.id)).toBe(true)
      expect(await stored(copy.storageKey)).toBe(true)
    }
    for (const linked of [picture.id, folderPicture.id, video.id])
      expect(shown.has(linked)).toBe(false)
    expect(shown.has(font.id) && shown.has(foreign.id)).toBe(true)

    // Each linked asset with its copy, the folder it came from and the mover.
    const pairs = await movedPairs(moving)
    expect(pairs).toHaveLength(3)
    for (const pair of pairs) {
      expect(pair).toMatchObject({ fromFolderId: F, movedByUserId: owner, recopiedAt: null })
      expect(copies.map((c) => c.id)).toContain(pair.copyAssetId)
    }
    expect(pairs.map((p) => p.sourceAssetId).sort()).toEqual(
      [picture.id, folderPicture.id, video.id].sort(),
    )
    pictureCopy = pairs.find((p) => p.sourceAssetId === picture.id)!.copyAssetId!

    const videoCopy = copies.find((c) => c.kind === 'video')!
    expect(videoCopy.transcodeStatus).toBe('done')
    for (const key of [videoCopy.playbackKey, videoCopy.posterKey, videoCopy.thumbnailKey]) {
      expect(key).toMatch(new RegExp(`^decks/${moving}/videos/${videoCopy.id}/`))
      expect(await stored(key!)).toBe(true)
    }
  })

  it('moves nothing when a linked picture cannot be copied first', async () => {
    const stuck = await newDeck('stuck', F)
    const lost = await media({ componentId: cmp }, { missing: true })
    await show(stuck, lost.id)

    const err = await serviceErrorOf(
      createDecksService(deps).moveDecks({
        userId: owner,
        sourceFolderId: F,
        deckIds: [stuck],
        destFolderId: G,
      }),
    )
    expect(err.status).toBe(503)
    const [deck] = await db.select().from(decks).where(eq(decks.id, stuck))
    expect(deck!.folderId).toBe(F)
    expect(await rowsOf(stuck)).toEqual([])
    expect(await movedPairs(stuck)).toEqual([])
    expect((await shownBy(stuck)).has(lost.id)).toBe(true)
  })

  describe('old references an undo brings back (N1)', () => {
    it('re-points them at the recorded copy: five undo/redo cycles make no copy', async () => {
      const before = (await rowsOf(moving)).length
      for (let i = 0; i < 5; i++) {
        // An editor's undo puts the old id back after the move…
        await show(moving, picture.id)
        const report = await repointMovedMedia(deps, moving)
        expect(report).toMatchObject({ copied: 0, repointed: 1, unresolved: 0 })
        const shown = await shownBy(moving)
        expect(shown.has(picture.id)).toBe(false)
        expect(shown.has(pictureCopy)).toBe(true)
      }
      expect(await rowsOf(moving)).toHaveLength(before)
      // Nothing left to do: a store that brings nothing back costs no copy.
      expect(await repointMovedMedia(deps, moving)).toBeNull()
    })

    it('does the same after a store, off the store path', async () => {
      const videos = (await rowsOf(moving)).filter((r) => r.kind === 'video').length
      await show(moving, video.id, 'video')
      checkMovedMediaAfterStore(deps, moving)
      await localisationsSettled(deps, moving)
      expect((await shownBy(moving)).has(video.id)).toBe(false)
      expect((await rowsOf(moving)).filter((r) => r.kind === 'video')).toHaveLength(videos)
    })

    it('never copies an id the deck did not reference when it moved, even of the folder it left', async () => {
      const before = (await rowsOf(moving)).length
      const unrecorded = await media({ componentId: cmp })
      const planted = await media({ componentId: cmpH })
      await show(moving, unrecorded.id)
      await show(moving, planted.id)
      for (let i = 0; i < 3; i++) expect(await repointMovedMedia(deps, moving)).toBeNull()
      const shown = await shownBy(moving)
      expect(shown.has(unrecorded.id) && shown.has(planted.id)).toBe(true)
      expect(await rowsOf(moving)).toHaveLength(before)
    })

    it('copies once more when the recorded copy is gone — once only', async () => {
      // The deck's copy is deleted (media.delete on the deck): the row's copy goes to NULL.
      await createMediaService(deps).delete({
        userId: owner,
        assetId: pictureCopy,
        owner: { deckId: moving },
      })
      expect((await movedPairs(moving)).find((p) => p.sourceAssetId === picture.id)).toMatchObject({
        copyAssetId: null,
        recopiedAt: null,
      })
      await show(moving, picture.id)
      const again = await repointMovedMedia(deps, moving)
      expect(again).toMatchObject({ copied: 1, unresolved: 0 })
      const pair = (await movedPairs(moving)).find((p) => p.sourceAssetId === picture.id)!
      expect(pair.copyAssetId).not.toBeNull()
      expect(pair.recopiedAt).not.toBeNull()
      expect((await shownBy(moving)).has(pair.copyAssetId!)).toBe(true)

      // Gone again: never a third copy; the reference stays as the undo left it.
      await createMediaService(deps).delete({
        userId: owner,
        assetId: pair.copyAssetId!,
        owner: { deckId: moving },
      })
      const count = (await rowsOf(moving)).length
      await show(moving, picture.id)
      expect(await repointMovedMedia(deps, moving)).toMatchObject({ copied: 0, unresolved: 1 })
      expect(await rowsOf(moving)).toHaveLength(count)
      expect((await shownBy(moving)).has(picture.id)).toBe(true)
    })

    it('copies once, not twice, when a store and a revert run at the same time', async () => {
      // A video whose copy is gone, brought back by an undo; the store-time
      // check and a revert's pass race for it.
      const pair = (await movedPairs(moving)).find((p) => p.sourceAssetId === video.id)!
      await createMediaService(deps).delete({
        userId: owner,
        assetId: pair.copyAssetId!,
        owner: { deckId: moving },
      })
      await show(moving, video.id, 'video')
      const videosBefore = (await rowsOf(moving)).filter((r) => r.kind === 'video').length
      checkMovedMediaAfterStore(deps, moving)
      const [a, b] = await Promise.all([
        repointMovedMedia(deps, moving),
        repointMovedMedia(deps, moving),
      ])
      await localisationsSettled(deps, moving)
      expect((a?.copied ?? 0) + (b?.copied ?? 0)).toBeLessThanOrEqual(1)
      expect((await rowsOf(moving)).filter((r) => r.kind === 'video')).toHaveLength(
        videosBefore + 1,
      )
      expect((await shownBy(moving)).has(video.id)).toBe(false)
    })

    it('leaves alone what the deck may show again once it moved back', async () => {
      const back = await createDecksService(deps).moveDecks({
        userId: owner,
        sourceFolderId: G,
        deckIds: [moving],
        destFolderId: F,
      })
      expect(back.movedCount).toBe(1)
      // In F the deck may show F's media: an old reference stays a link.
      await show(moving, picture.id)
      expect(await repointMovedMedia(deps, moving)).toBeNull()
      expect((await shownBy(moving)).has(picture.id)).toBe(true)
      // And moving out again reuses the copies it still has rather than copying anew.
      const out = await createDecksService(deps).moveDecks({
        userId: owner,
        sourceFolderId: F,
        deckIds: [moving],
        destFolderId: G,
      })
      expect(out.movedCount).toBe(1)
      expect((await shownBy(moving)).has(picture.id)).toBe(false)
    })
  })

  describe("the mover's authority and budget", () => {
    let spent: string
    let item: { id: string; storageKey: string }
    let clip: { id: string; storageKey: string }

    it('moves a deck of the spender (an editor of both folders)', async () => {
      spent = await newDeck('spent', F, [[spender, 'owner']])
      item = await media({ componentId: cmp })
      clip = await media({ componentId: cmp }, { kind: 'video' })
      await show(spent, item.id)
      await show(spent, clip.id, 'video')
      const moved = await createDecksService(deps).moveDecks({
        userId: spender,
        sourceFolderId: F,
        deckIds: [spent],
        destFolderId: G,
      })
      expect(moved.media).toEqual([{ deckId: spent, copied: 2, unresolved: 0, copyFailed: 0 }])
      expect((await movedPairs(spent)).every((p) => p.movedByUserId === spender)).toBe(true)
    })

    async function loseCopyAndUndo(assetId: string, type: 'image' | 'video' = 'image') {
      const pair = (await movedPairs(spent)).find((p) => p.sourceAssetId === assetId)!
      if (pair.copyAssetId !== null)
        await db.delete(mediaAssets).where(eq(mediaAssets.id, pair.copyAssetId))
      await show(spent, assetId, type)
    }

    it('copies nothing on the budget of a mover who spent it, and tries again later', async () => {
      await loseCopyAndUndo(item.id)
      for (let i = 0; i < MEDIA_COPY_RATE_LIMIT.max; i++) {
        try {
          spendMediaCopyBudget(spender)
        } catch {
          break
        }
      }
      const report = await repointMovedMedia(deps, spent)
      expect(report).toMatchObject({ copied: 0, unresolved: 1 })
      // Not spent: the claim was given back for a later pass.
      expect((await movedPairs(spent)).find((p) => p.sourceAssetId === item.id)).toMatchObject({
        recopiedAt: null,
      })
      expect((await shownBy(spent)).has(item.id)).toBe(true)
    })

    it('never transcodes: a video whose source is not finished stays unresolved', async () => {
      await db
        .update(mediaAssets)
        .set({ transcodeStatus: 'processing' })
        .where(eq(mediaAssets.id, clip.id))
      try {
        await loseCopyAndUndo(clip.id, 'video')
        const before = (await rowsOf(spent)).length
        await repointMovedMedia(deps, spent)
        expect(await rowsOf(spent)).toHaveLength(before)
        expect((await shownBy(spent)).has(clip.id)).toBe(true)
      } finally {
        await db
          .update(mediaAssets)
          .set({ transcodeStatus: 'done' })
          .where(eq(mediaAssets.id, clip.id))
      }
    })

    it('copies nothing once the mover may not read the folder any more', async () => {
      await db
        .delete(folderPermissions)
        .where(and(eq(folderPermissions.folderId, F), eq(folderPermissions.userId, spender)))
      try {
        const before = (await rowsOf(spent)).length
        const report = await repointMovedMedia(deps, spent)
        expect(report).toMatchObject({ copied: 0, refused: 2 })
        expect(await rowsOf(spent)).toHaveLength(before)
        // Given back: a mover who regains access may still copy it.
        expect(
          (await movedPairs(spent))
            .filter((p) => p.recopiedAt !== null)
            .map((p) => p.sourceAssetId),
        ).toEqual([])
      } finally {
        await db.insert(folderPermissions).values({ folderId: F, userId: spender, role: 'editor' })
      }
    })
  })
})

describe('a stamp racing a move: the real stamp, move, settle and copy (N2)', () => {
  it('carries the picture the stamp linked into the deck that moved meanwhile, recorded', async () => {
    const stamped = await media({ componentId: cmpStamp })
    await writeLiveDoc(
      deps,
      'component',
      cmpStamp,
      (doc) =>
        writeComponentMaster(
          doc,
          [
            {
              id: 'logo',
              type: 'image',
              assetId: stamped.id,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              rotation: 0,
              opacity: 1,
            } as SlideObject,
          ],
          [],
        ),
      LOCAL_ORIGIN,
    )
    const racing = await newDeck('racing', F)
    const slideId = await emptySlide(racing)

    await stampComponentIntoDeck(deps, {
      deckId: racing,
      componentId: cmpStamp,
      slideId,
      // Staged for F; the deck moves to G before the stamp is written.
      prepare: async () => {
        const prepared = await createComponentsService(deps).prepareStamp({
          userId: owner,
          componentId: cmpStamp,
          deckId: racing,
        })
        const moved = await createDecksService(deps).moveDecks({
          userId: owner,
          sourceFolderId: F,
          deckIds: [racing],
          destFolderId: G,
        })
        expect(moved.media).toEqual([{ deckId: racing, copied: 0, unresolved: 0, copyFailed: 0 }])
        return prepared
      },
    })

    const [copy] = await rowsOf(racing)
    expect(copy).toBeDefined()
    const shown = await shownBy(racing)
    expect(shown.has(stamped.id)).toBe(false)
    expect(shown.has(copy!.id)).toBe(true)
    expect(await movedPairs(racing)).toMatchObject([
      { sourceAssetId: stamped.id, copyAssetId: copy!.id, fromFolderId: F, movedByUserId: owner },
    ])
    // An undo of the settle's re-pointing is re-pointed, never copied again.
    await show(racing, stamped.id)
    expect(await repointMovedMedia(deps, racing)).toMatchObject({ copied: 0, repointed: 1 })
    expect(await rowsOf(racing)).toHaveLength(1)
  })
})

describe('whoever may read linked media may carry it into another folder (D1)', () => {
  it('copies a stamped picture into a duplicate in another folder for an editor of the source folder', async () => {
    const source = await newDeck('dup-source', F)
    const stamped = await media({ componentId: cmp })
    await show(source, stamped.id)

    const copy = await createDecksService(deps).duplicate({
      userId: owner,
      deckId: source,
      folderId: G,
    })
    createdDecks.add(copy.id)
    expect(copy).toMatchObject({ mediaCopied: 1, skippedImages: 0 })
    const [row] = await rowsOf(copy.id)
    expect((await shownBy(copy.id)).has(row!.id)).toBe(true)
    expect(await stored(row!.storageKey)).toBe(true)
  })

  it('copies it for a deck-only guest into their own folder too (duplicate, insertFrom)', async () => {
    const shared = await newDeck('shared-with-guest', F, [[guest, 'editor']])
    const stamped = await media({ componentId: cmp })
    const own = await media({ deckId: shared })
    await show(shared, stamped.id)
    await show(shared, own.id)

    const copy = await createDecksService(deps).duplicate({
      userId: guest,
      deckId: shared,
      folderId: H,
    })
    createdDecks.add(copy.id)
    expect(copy).toMatchObject({ mediaCopied: 2, skippedImages: 0 })
    const shown = await shownBy(copy.id)
    expect(shown.has(stamped.id) || shown.has(own.id)).toBe(false)
    for (const row of await rowsOf(copy.id)) expect(shown.has(row.id)).toBe(true)

    const target = await newDeck('guest-target', H, [[guest, 'owner']])
    const prepared = await stageDeckInsert(deps, {
      userId: guest,
      sourceDeckId: shared,
      targetDeckId: target,
    })
    const scratch = createSlideDoc()
    let skipped = -1
    scratch.doc.transact(() => {
      skipped = prepared.apply(scratch).skipped.images
    })
    expect(skipped).toBe(0)
    expect(await rowsOf(target)).toHaveLength(2)
  })

  it('never copies it for someone who may not read its folder: unresolved and counted', async () => {
    const holder = await newDeck('unreadable-source', F)
    const stamped = await media({ componentId: cmp })
    const out = await copyMedia(deps, {
      userId: stranger,
      source: { deckId: holder },
      sourceFolderId: F,
      target: { deckId: holder },
      targetFolderId: H,
      assetIds: new Set([stamped.id]),
      families: new Set(),
      budgeted: false,
    })
    expect(out).toMatchObject({ unresolved: 1, refused: 1, copyFailed: 0 })
    expect(out.rows).toEqual([])
  })

  it('carries a cut picture across folders as a copy, and keeps it a link within the folder', async () => {
    // The source deck no longer references the picture (it was cut).
    const cutFrom = await newDeck('cut-from', F)
    await emptySlide(cutFrom)
    const cut = await media({ componentId: cmp })
    const objects = [
      { id: 'img', type: 'image', assetId: cut.id, x: 0, y: 0, width: 50, height: 50 },
    ]

    const elsewhere = await newDeck('paste-elsewhere', G)
    const there = await insertObjectsFrom(deps, {
      userId: owner,
      source: { deckId: cutFrom },
      target: { deckId: elsewhere },
      slideId: await emptySlide(elsewhere),
      objects,
    })
    expect(there).toMatchObject({ mediaRegistered: 1, skippedImages: 0 })
    const [row] = await rowsOf(elsewhere)
    expect((await shownBy(elsewhere)).has(row!.id)).toBe(true)

    const here = await newDeck('paste-here', F)
    const within = await insertObjectsFrom(deps, {
      userId: owner,
      source: { deckId: cutFrom },
      target: { deckId: here },
      slideId: await emptySlide(here),
      objects,
    })
    expect(within).toMatchObject({ mediaRegistered: 0, skippedImages: 0 })
    expect(await rowsOf(here)).toEqual([])
    expect((await shownBy(here)).has(cut.id)).toBe(true)
  })
})

describe("deleting a folder's media", () => {
  it("deletes a folder's own picture for its owner through the folder target", async () => {
    const own = await media({ folderId: F })
    await expect(
      createMediaService(deps).delete({ userId: owner, assetId: own.id, owner: { folderId: F } }),
    ).resolves.toEqual({ outcome: 'deleted' })
    expect(await db.select().from(mediaAssets).where(eq(mediaAssets.id, own.id))).toEqual([])
    expect(await stored(own.storageKey)).toBe(false)
  })

  it("removes a deleted font's file only when no deck clone names it (N4)", async () => {
    const withDecks = await media({ folderId: F }, { kind: 'font' })
    const cloned = await createFoldersService(deps).deleteFont({
      userId: owner,
      folderId: F,
      assetId: withDecks.id,
    })
    expect(cloned.promotedToDeckCount).toBeGreaterThan(0)
    expect(await stored(withDecks.storageKey)).toBe(true)

    const alone = await media({ folderId: L }, { kind: 'font' })
    const none = await createFoldersService(deps).deleteFont({
      userId: owner,
      folderId: L,
      assetId: alone.id,
    })
    expect(none.promotedToDeckCount).toBe(0)
    expect(await stored(alone.storageKey)).toBe(false)
  })
})

describe('the PowerPoint export takes what the deck shows (item 11)', () => {
  it("embeds the folder's linked picture, and nothing the document merely names", async () => {
    const deckId = await newDeck('export', F)
    const linked = await media({ componentId: cmp })
    const foreign = await media({ componentId: cmpH })
    await show(deckId, linked.id)
    await show(deckId, foreign.id)

    const out = await exportDeckToPptx(deps, deckId)
    if (!out.ok) throw new Error(`export failed: ${out.error}`)
    const zip = await JSZip.loadAsync(await out.package.toBuffer())
    const media_ = Object.keys(zip.files).filter((p) => p.startsWith('ppt/media/'))
    expect(media_).toHaveLength(1)
    expect(Buffer.from(await zip.file(media_[0]!)!.async('uint8array')).equals(PNG)).toBe(true)
  })
})
