/**
 * hocuspocus/persistence.integration.test.ts — storing a document whose
 * deck, folder or component was deleted while it was still loaded, against
 * a real Postgres. The sync server stores a document on a debounce, so the
 * store can run after the delete; it used to fail with a foreign-key error
 * logged as "FAILED to store snapshot". The store now checks its owner under
 * `FOR KEY SHARE` and stores nothing when it is gone. Excluded from
 * `pnpm test`; run with `just integration`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import type { onStoreDocumentPayload } from '@hocuspocus/server'
import { db, pool } from '../db/client.js'
import { componentUpdates, components, deckUpdates, decks, folders, users } from '../db/schema.js'
import { PostgresPersistence } from './persistence.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const user = `it-persist-${suffix}`
const folder = `it-persist-folder-${suffix}`
const deck = `it-persist-deck-${suffix}`
const component = `it-persist-cmp-${suffix}`

const persistence = new PostgresPersistence({ db })

function store(documentName: string, value: string): Promise<void> {
  const document = new Y.Doc()
  document.getMap('probe').set('value', value)
  return persistence.onStoreDocument({
    document,
    documentName,
    context: { role: 'owner', userId: user },
  } as unknown as onStoreDocumentPayload)
}

beforeAll(async () => {
  await db.insert(users).values({ sub: user, email: `${user}@example.test`, name: 'IT' })
  await db.insert(folders).values({ id: folder, ownerUserId: user, name: 'Persistence' })
  await db
    .insert(decks)
    .values({ id: deck, title: 'Gone soon', ownerUserId: user, folderId: folder })
  await db.insert(components).values({ id: component, folderId: folder, name: 'Gone soon' })
})

afterAll(async () => {
  await db.delete(decks).where(eq(decks.id, deck))
  await db.delete(folders).where(eq(folders.id, folder))
  await db.delete(users).where(inArray(users.sub, [user]))
  await pool.end()
})

describe('storing the document of a deleted owner', () => {
  it('stores a deck while it exists, and nothing — without an error — once it is deleted', async () => {
    await store(deck, 'first')
    expect(await db.select().from(deckUpdates).where(eq(deckUpdates.deckId, deck))).toHaveLength(1)

    await db.delete(decks).where(eq(decks.id, deck))
    await expect(store(deck, 'after the delete')).resolves.toBeUndefined()
    expect(await db.select().from(deckUpdates).where(eq(deckUpdates.deckId, deck))).toHaveLength(0)
  })

  it('does the same for a component master', async () => {
    await store(`component:${component}`, 'first')
    await db.delete(components).where(eq(components.id, component))
    await expect(store(`component:${component}`, 'after')).resolves.toBeUndefined()
    expect(
      await db.select().from(componentUpdates).where(eq(componentUpdates.componentId, component)),
    ).toHaveLength(0)
  })
})
