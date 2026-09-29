/**
 * agent/folderFonts.integration.test.ts — the production folder-font reader
 * against a real Postgres: the folder is found through the deck's
 * `folder_id`, and its font assets give family and weight. Excluded from
 * `pnpm test`; run with `pnpm --filter @narrative/server test:integration`
 * against the local dev database. Creates its own rows under random ids and
 * deletes them after.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { decks, folders, mediaAssets, users } from '../db/schema.js'
import { createMediaAsset } from '../media/assets.js'
import { createDbFolderFontsReader } from './folderFonts.js'

const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const emptyFolderId = `it-folder-empty-${suffix}`
const deckId = `it-deck-${suffix}`
const fontIds = [`it-font-a-${suffix}`, `it-font-b-${suffix}`]

beforeAll(async () => {
  await db.insert(users).values({ sub: userSub, email: `${userSub}@example.test`, name: 'IT' })
  await db.insert(folders).values([
    { id: folderId, ownerUserId: userSub, name: 'IT folder' },
    { id: emptyFolderId, ownerUserId: userSub, name: 'IT empty folder' },
  ])
  await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT deck' })
  for (const [i, weight] of [300, 600].entries()) {
    await createMediaAsset(db, {
      id: fontIds[i]!,
      folderId,
      uploaderUserId: userSub,
      mimeType: 'font/woff2',
      sizeBytes: 1000,
      storageKey: `folders/${folderId}/fonts/${fontIds[i]}.woff2`,
      kind: 'font',
      fontFamily: 'Brand Sans',
      fontWeight: weight,
      fontStyle: 'normal',
      fontPostscriptName: `BrandSans-${weight}`,
    })
  }
})

afterAll(async () => {
  for (const id of fontIds) await db.delete(mediaAssets).where(eq(mediaAssets.id, id))
  await db.delete(decks).where(eq(decks.id, deckId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(folders).where(eq(folders.id, emptyFolderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await pool.end()
})

describe('createDbFolderFontsReader', () => {
  const read = createDbFolderFontsReader(db)

  it("reads a deck's folder fonts as family and weight", async () => {
    const faces = await read({ deckId })
    expect([...(faces ?? [])].sort((a, b) => a.weight - b.weight)).toEqual([
      { family: 'Brand Sans', weight: 300 },
      { family: 'Brand Sans', weight: 600 },
    ])
  })

  it('answers null for a folder without fonts and an unknown target', async () => {
    expect(await read({ folderId: emptyFolderId })).toBeNull()
    expect(await read({ deckId: `missing-${suffix}` })).toBeNull()
  })
})
