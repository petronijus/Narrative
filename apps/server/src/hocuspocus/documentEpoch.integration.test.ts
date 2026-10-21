/**
 * hocuspocus/documentEpoch.integration.test.ts — the document epoch in a
 * real Postgres (ADR 0017, migration 0041): every document starts at 1, a
 * bump advances one document only, inside the caller's transaction (rolled
 * back with it), and a missing owner reads as null. Excluded from
 * `pnpm test`; run with `just integration`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { components, decks, folders, users } from '../db/schema.js'
import { bumpDocumentEpoch, readDocumentEpoch } from './documentEpoch.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const user = `it-epoch-${suffix}`
const folder = `it-epoch-folder-${suffix}`
const deck = `it-epoch-deck-${suffix}`
const otherDeck = `it-epoch-deck2-${suffix}`
const component = `it-epoch-cmp-${suffix}`

beforeAll(async () => {
  await db.insert(users).values({ sub: user, email: `${user}@example.test`, name: 'IT' })
  await db.insert(folders).values({ id: folder, ownerUserId: user, name: 'Epochs' })
  await db.insert(decks).values([
    { id: deck, title: 'Epoch', ownerUserId: user, folderId: folder },
    { id: otherDeck, title: 'Epoch 2', ownerUserId: user, folderId: folder },
  ])
  await db.insert(components).values({ id: component, folderId: folder, name: 'Epoch' })
})

afterAll(async () => {
  await db.delete(decks).where(inArray(decks.id, [deck, otherDeck]))
  await db.delete(folders).where(eq(folders.id, folder))
  await db.delete(users).where(eq(users.sub, user))
  await pool.end()
})

describe('document epochs', () => {
  it('starts every document at 1, under every document name', async () => {
    for (const name of [deck, `deck:${deck}`, `folder:${folder}`, `component:${component}`]) {
      expect((await readDocumentEpoch(db, name))?.docEpoch).toBe(1)
    }
  })

  it('bumps one document only', async () => {
    expect(await bumpDocumentEpoch(db, deck)).toBe(2)
    expect((await readDocumentEpoch(db, `deck:${deck}`))?.docEpoch).toBe(2)
    expect((await readDocumentEpoch(db, otherDeck))?.docEpoch).toBe(1)
    expect(await bumpDocumentEpoch(db, `folder:${folder}`)).toBe(2)
    expect(await bumpDocumentEpoch(db, `component:${component}`)).toBe(2)
    expect((await readDocumentEpoch(db, `component:${component}`))?.docEpoch).toBe(2)
  })

  it('bumps inside the transaction that replaces the rows, and rolls back with it', async () => {
    const before = (await readDocumentEpoch(db, otherDeck))?.docEpoch
    await expect(
      db.transaction(async (tx) => {
        expect(await bumpDocumentEpoch(tx, otherDeck)).toBe((before ?? 0) + 1)
        throw new Error('the replacement failed')
      }),
    ).rejects.toThrow('the replacement failed')
    expect((await readDocumentEpoch(db, otherDeck))?.docEpoch).toBe(before)
  })

  it("reads the instance's generation and floor with the document's epoch", async () => {
    const current = await readDocumentEpoch(db, deck)
    expect(current?.generation).toBeGreaterThanOrEqual(1)
    expect(current!.floor).toBeLessThanOrEqual(current!.generation)
  })

  it('reads and bumps nothing for a document whose owner does not exist', async () => {
    expect(await readDocumentEpoch(db, `missing-${suffix}`)).toBeNull()
    expect(await bumpDocumentEpoch(db, `component:missing-${suffix}`)).toBeNull()
  })
})
