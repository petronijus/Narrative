/**
 * services/deckThumbnailStore.integration.test.ts — a deck's card picture
 * against a real Postgres and MinIO: each picture under a key of its own,
 * the one it replaced deleted; writers racing each other leave the row on
 * an object that exists and nothing else behind; a deck deleted meanwhile
 * keeps nothing; bytes that are not the declared image are refused.
 *
 * Excluded from `pnpm test`; run with `just integration` (the docker services
 * up). It creates its own user and deck under random ids and removes them,
 * and the files it stored, afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { db, pool } from '../db/client.js'
import { decks, folders, users } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from '../media/s3Client.js'
import { storeDeckThumbnail, ThumbnailFormatError } from './deckThumbnailStore.js'

const s3 = buildS3Client()
const owner = `it-card-${nanoid(8)}`
const deckId = `itc${nanoid(9)}`
const goneDeck = `itg${nanoid(9)}`
const folderId = `itf${nanoid(9)}`

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6])

async function keysUnder(prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: MEDIA_BUCKET, Prefix: prefix }))
  return (out.Contents ?? []).map((o) => o.Key!).sort()
}

async function rowKey(): Promise<string | null> {
  const [row] = await db.select({ key: decks.thumbnailKey }).from(decks).where(eq(decks.id, deckId))
  return row?.key ?? null
}

beforeAll(async () => {
  await db.insert(users).values({ sub: owner, email: `${owner}@example.test`, name: 'Owner' })
  await db.insert(folders).values({ id: folderId, ownerUserId: owner, name: 'card' })
  await db.insert(decks).values({ id: deckId, title: 'card', ownerUserId: owner, folderId })
})

afterAll(async () => {
  for (const prefix of [`decks/${deckId}/`, `decks/${goneDeck}/`]) {
    const keys = await keysUnder(prefix)
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: MEDIA_BUCKET,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      )
    }
  }
  await db.delete(decks).where(eq(decks.ownerUserId, owner))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(users).where(eq(users.sub, owner))
  await pool.end()
})

describe('storeDeckThumbnail (Postgres + MinIO)', () => {
  it('stores each picture under a key of its own, keeping only the one it replaced', async () => {
    const now = { graceMs: 0 }
    const first = await storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/png' }, now)
    expect(first?.thumbnailKey).toMatch(new RegExp(`^decks/${deckId}/thumb-[\\w-]{12}\\.png$`))
    const second = await storeDeckThumbnail(db, deckId, { bytes: JPEG, mime: 'image/jpeg' }, now)
    expect(second?.thumbnailKey).toMatch(/\.jpg$/)
    // A page given the first picture's URL a moment ago still shows it…
    expect(await keysUnder(`decks/${deckId}/`)).toEqual(
      [first!.thumbnailKey, second!.thumbnailKey].sort(),
    )
    // …until the next one replaces the second.
    const third = await storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/png' }, now)
    expect(await keysUnder(`decks/${deckId}/`)).toEqual(
      [second!.thumbnailKey, third!.thumbnailKey].sort(),
    )
    expect(third!.thumbnailUpdatedAt!.getTime()).toBeGreaterThanOrEqual(
      first!.thumbnailUpdatedAt!.getTime(),
    )
  })

  it('keeps a replaced picture younger than the grace period', async () => {
    const before = await keysUnder(`decks/${deckId}/`)
    await storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/png' })
    await storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/png' })
    const after = await keysUnder(`decks/${deckId}/`)
    for (const key of before) expect(after).toContain(key)
    expect(after).toHaveLength(before.length + 2)
  })

  it('leaves the row on an existing object, and nothing else, when writers race', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        storeDeckThumbnail(
          db,
          deckId,
          i % 2 === 0 ? { bytes: PNG, mime: 'image/png' } : { bytes: JPEG, mime: 'image/jpeg' },
        ),
      ),
    )
    // The row names an object that exists (the racers' fresh pictures stay
    // for the grace period; the next store after it drops them).
    const key = await rowKey()
    expect(await keysUnder(`decks/${deckId}/`)).toContain(key)
    await storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/png' }, { graceMs: 0 })
    const last = await rowKey()
    expect(await keysUnder(`decks/${deckId}/`)).toEqual([key, last].sort())
  })

  it('keeps nothing for a deck that does not exist', async () => {
    expect(await storeDeckThumbnail(db, goneDeck, { bytes: PNG, mime: 'image/png' })).toBeNull()
    expect(await keysUnder(`decks/${goneDeck}/`)).toEqual([])
  })

  it('refuses bytes that are not the declared image, before storing anything', async () => {
    const before = await rowKey()
    await expect(
      storeDeckThumbnail(db, deckId, {
        bytes: new TextEncoder().encode('<svg/>'),
        mime: 'image/png',
      }),
    ).rejects.toBeInstanceOf(ThumbnailFormatError)
    await expect(
      storeDeckThumbnail(db, deckId, { bytes: PNG, mime: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(ThumbnailFormatError)
    const stored = await keysUnder(`decks/${deckId}/`)
    await expect(
      storeDeckThumbnail(db, deckId, { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(ThumbnailFormatError)
    expect(await rowKey()).toBe(before)
    expect(await keysUnder(`decks/${deckId}/`)).toEqual(stored)
  })
})
