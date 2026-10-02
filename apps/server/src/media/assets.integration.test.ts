/**
 * media/assets.integration.test.ts — component-owned media (A2.12b) against a
 * real Postgres (migrations 0027 and 0028 applied): the database keeps a
 * media row to one owner and a new component id to the storage-safe
 * alphabet, `keysStillReferenced` tells which stored files a row still
 * names, and deleting a master cascades its rows. Excluded from `pnpm test`;
 * run with `just integration` against the local dev database. It creates its
 * own user, folder, deck and components under random ids and deletes them
 * afterwards (the deck first; components and their media cascade with the
 * folder).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { components, decks, folders, mediaAssets, users } from '../db/schema.js'
import { keysStillReferenced } from './bucketCleanup.js'

const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const deckId = `it-deck-${suffix}`
const componentA = `it-cmpA-${suffix}`
const componentB = `it-cmpB-${suffix}`

type MediaRow = typeof mediaAssets.$inferInsert

function mediaRow(fields: Partial<MediaRow> & Pick<MediaRow, 'storageKey'>): MediaRow {
  return {
    id: `it-asset-${nanoid(10)}`,
    uploaderUserId: userSub,
    mimeType: 'image/png',
    sizeBytes: 1024,
    ...fields,
  }
}

/** The Postgres error behind a failed query (Drizzle wraps it in `cause`). */
async function pgErrorOf(p: PromiseLike<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await p
  } catch (e) {
    let err: unknown = e
    while (err instanceof Error) {
      if ('code' in err && typeof (err as { code: unknown }).code === 'string')
        return err as { code?: string; constraint?: string }
      err = err.cause
    }
    throw e
  }
  throw new Error('expected the query to fail')
}

beforeAll(async () => {
  await db.insert(users).values({ sub: userSub, email: `${userSub}@example.test`, name: 'IT' })
  await db.insert(folders).values({ id: folderId, ownerUserId: userSub, name: 'IT folder' })
  await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT deck' })
  await db.insert(components).values([
    { id: componentA, folderId, name: 'IT component A' },
    { id: componentB, folderId, name: 'IT component B' },
  ])
})

afterAll(async () => {
  await db.delete(decks).where(eq(decks.id, deckId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await pool.end()
})

describe('component-owned media in Postgres', () => {
  it('refuses a media row owned by both a deck and a component (media_assets_one_owner)', async () => {
    const err = await pgErrorOf(
      db.insert(mediaAssets).values(
        mediaRow({
          storageKey: `components/${componentA}/both.png`,
          deckId,
          componentId: componentA,
        }),
      ),
    )
    expect(err).toMatchObject({ code: '23514', constraint: 'media_assets_one_owner' })
  })

  it('refuses a new component id with a slash (components_id_storage_safe)', async () => {
    const err = await pgErrorOf(
      db
        .insert(components)
        .values({ id: `${componentA}/../${componentB}`, folderId, name: 'Escape' }),
    )
    expect(err).toMatchObject({ code: '23514', constraint: 'components_id_storage_safe' })
  })

  it('keeps a stored file another row still names, whichever key of the row names it', async () => {
    // A deleted folder font is cloned onto each deck of the folder under one
    // stored file: deleting one clone's deck must not remove it.
    const shared = `fonts/${folderId}/${nanoid(8)}/original.ttf`
    const poster = `decks/${deckId}/videos/${nanoid(8)}/poster.jpg`
    const gone = `decks/${deckId}/uploads/${nanoid(8)}/original.png`
    await db.insert(mediaAssets).values([
      mediaRow({ storageKey: shared, deckId, kind: 'font', mimeType: 'font/ttf' }),
      mediaRow({
        storageKey: `decks/${deckId}/uploads/${nanoid(8)}/original.mp4`,
        deckId,
        kind: 'video',
        mimeType: 'video/mp4',
        posterKey: poster,
      }),
    ])
    expect(await keysStillReferenced(db, [shared, poster, gone, ''])).toEqual(
      new Set([shared, poster]),
    )
    expect(await keysStillReferenced(db, [])).toEqual(new Set())
  })

  it("removes a component's media rows with the component, and leaves other owners' rows", async () => {
    await db.insert(mediaAssets).values(
      mediaRow({
        storageKey: `components/${componentA}/uploads/c/original.png`,
        componentId: componentA,
      }),
    )
    const countOf = async (componentId: string): Promise<number> =>
      (
        await db
          .select({ id: mediaAssets.id })
          .from(mediaAssets)
          .where(eq(mediaAssets.componentId, componentId))
      ).length
    expect(await countOf(componentA)).toBeGreaterThan(0)

    await db.delete(components).where(eq(components.id, componentA))

    expect(await countOf(componentA)).toBe(0)
    expect(await countOf(componentB)).toBeGreaterThan(0)
    const deckRows = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(inArray(mediaAssets.deckId, [deckId]))
    expect(deckRows.length).toBeGreaterThan(0)
  })
})
