/**
 * services/linkedMedia.integration.test.ts — linked component media (folder
 * sharing, step 2; docs/plans/folder-sharing.md) against a real Postgres and
 * MinIO: a master's picture used within its folder is linked, never copied;
 * taken into another folder it is copied; a deck moving to another folder
 * takes its linked pictures along; a deleted component's pictures stay with
 * the folder, files and all. Excluded from `pnpm test`; run with
 * `just integration` (the docker services up).
 *
 * It creates its own user, folders, decks and components under random ids
 * and deletes them afterwards (their media rows cascade; the few stored
 * files it put in the bucket are removed too).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import { DeleteObjectsCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { addSlide, getSlideObjectsCtx, hydrateSlideDoc, LOCAL_ORIGIN } from '@narrative/slide-model'
import { db, pool } from '../db/client.js'
import { components, decks, folderPermissions, folders, mediaAssets, users } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { quietLog } from '../test-support/agentWorld.js'
import { copyMedia, referencedAssets } from './deckInsert.js'
import { localiseLinkedMedia } from './localiseMedia.js'
import { createComponentsService } from './components.js'
import { readDocCopy, writeLiveDoc } from './liveDocs.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-link-${name}-${suffix}`
const user = id('user')
const folderF = id('f')
const folderG = id('g')
const deckF = id('deck-f')
const deckG = id('deck-g')
const master = id('cmp')
const doomed = id('cmp-doomed')

const deps = { db, log: quietLog, hocuspocus: () => null }
const s3 = buildS3Client()
const putKeys: string[] = []

/** A master's picture: a row and a stored file under its prefix. */
async function masterPicture(componentId: string): Promise<{ id: string; storageKey: string }> {
  const assetId = nanoid(12)
  const storageKey = `components/${componentId}/uploads/${assetId}/original.png`
  await s3.send(
    new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: storageKey, Body: Buffer.from('png') }),
  )
  putKeys.push(storageKey)
  await db.insert(mediaAssets).values({
    id: assetId,
    componentId,
    uploaderUserId: user,
    mimeType: 'image/png',
    sizeBytes: 3,
    storageKey,
    kind: 'image',
  })
  return { id: assetId, storageKey }
}

/** Put an image showing `assetId` on the deck's first slide (stored, no sync server). */
async function showOnDeck(deckId: string, assetId: string): Promise<void> {
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
            type: 'image',
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

async function deckAssets(deckId: string): Promise<Set<string>> {
  const doc = await readDocCopy(deps, 'deck', deckId)
  try {
    return referencedAssets(doc.getArray<Y.Map<unknown>>('slides').toArray())
  } finally {
    doc.destroy()
  }
}

async function stored(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  await db.insert(users).values({ sub: user, email: `${user}@example.test`, name: 'IT' })
  await db.insert(folders).values([
    { id: folderF, ownerUserId: user, name: 'F' },
    { id: folderG, ownerUserId: user, name: 'G' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: folderF, userId: user, role: 'owner' },
    { folderId: folderG, userId: user, role: 'owner' },
  ])
  await db.insert(decks).values([
    { id: deckF, title: 'In F', ownerUserId: user, folderId: folderF },
    { id: deckG, title: 'In G', ownerUserId: user, folderId: folderG },
  ])
  await db.insert(components).values([
    { id: master, folderId: folderF, name: 'Logo' },
    { id: doomed, folderId: folderF, name: 'Going' },
  ])
})

afterAll(async () => {
  const rows = await db
    .select({ storageKey: mediaAssets.storageKey })
    .from(mediaAssets)
    .where(inArray(mediaAssets.deckId, [deckF, deckG]))
  const keys = [...putKeys, ...rows.map((r) => r.storageKey)]
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: MEDIA_BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  )
  await db.delete(decks).where(inArray(decks.id, [deckF, deckG]))
  await db.delete(folders).where(inArray(folders.id, [folderF, folderG]))
  await db.delete(users).where(eq(users.sub, user))
  await pool.end()
})

describe('linked component media', () => {
  it("links a master's picture within its folder and copies it into another", async () => {
    const picture = await masterPicture(master)
    const intoFolder = await copyMedia(deps, {
      userId: user,
      source: { componentId: master },
      sourceFolderId: folderF,
      target: { deckId: deckF },
      targetFolderId: folderF,
      assetIds: new Set([picture.id]),
      families: new Set(),
    })
    expect(intoFolder).toMatchObject({ rows: [], failed: 0 })
    expect(intoFolder.idMap.size).toBe(0)

    const elsewhere = await copyMedia(deps, {
      userId: user,
      source: { componentId: master },
      sourceFolderId: folderF,
      target: { deckId: deckG },
      targetFolderId: folderG,
      assetIds: new Set([picture.id]),
      families: new Set(),
      budgeted: false,
    })
    expect(elsewhere.failed).toBe(0)
    expect(elsewhere.rows).toHaveLength(1)
    expect(elsewhere.rows[0]).toMatchObject({ deckId: deckG, componentId: null })
    expect(elsewhere.idMap.get(picture.id)).toBe(elsewhere.rows[0]!.id)
    putKeys.push(elsewhere.rows[0]!.storageKey)
    expect(await stored(elsewhere.rows[0]!.storageKey)).toBe(true)
  })

  it('copies the pictures a deck links into it before it leaves the folder', async () => {
    const picture = await masterPicture(master)
    await showOnDeck(deckF, picture.id)

    const out = await localiseLinkedMedia(deps, {
      userId: user,
      deckId: deckF,
      fromFolderId: folderF,
      toFolderId: folderG,
    })
    expect(out).toEqual({ copied: 1, unresolved: 0 })
    const [copy] = await db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.deckId, deckF), eq(mediaAssets.kind, 'image')))
    expect(copy).toBeDefined()
    expect(await stored(copy!.storageKey)).toBe(true)
    // The deck now shows its own copy, not the master's picture.
    const shown = await deckAssets(deckF)
    expect(shown.has(copy!.id)).toBe(true)
    expect(shown.has(picture.id)).toBe(false)

    // Nothing left to take along: a second run copies nothing.
    expect(
      await localiseLinkedMedia(deps, {
        userId: user,
        deckId: deckF,
        fromFolderId: folderF,
        toFolderId: folderG,
      }),
    ).toEqual({ copied: 0, unresolved: 0 })
  })

  it("hands a deleted component's pictures to its folder, files and all", async () => {
    const picture = await masterPicture(doomed)
    await createComponentsService(deps).delete({ userId: user, componentId: doomed })

    expect(await db.select().from(components).where(eq(components.id, doomed))).toEqual([])
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, picture.id))
    expect(row).toMatchObject({ componentId: null, folderId: folderF, deckId: null })
    expect(await stored(picture.storageKey)).toBe(true)
  })
})
