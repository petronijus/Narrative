/**
 * agent/folderTokens.integration.test.ts — the production folder-token
 * reader against a real Postgres: the folder is found through the deck's
 * and the component's `folder_id`, and its stored document (no Hocuspocus
 * loaded) gives the snapshot. Excluded from `pnpm test`; run with
 * `pnpm --filter @narrative/server test:integration` against the local dev
 * database. Creates its own rows under random ids and deletes them after.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import { db, pool } from '../db/client.js'
import { components, decks, folderUpdates, folders, users } from '../db/schema.js'
import { quietLog } from '../test-support/agentWorld.js'
import { createDbFolderTokensReader } from './folderTokens.js'

const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const emptyFolderId = `it-folder-empty-${suffix}`
const deckId = `it-deck-${suffix}`
const componentId = `it-cmp-${suffix}`

function folderDocUpdate(): Uint8Array {
  const doc = new Y.Doc()
  const colors = new Y.Map<unknown>()
  doc.getMap<unknown>('tokens').set('colors', colors)
  const ink = new Y.Map<unknown>()
  colors.set('ink', ink)
  ink.set('name', 'Ink')
  ink.set('value', '#222222')
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

beforeAll(async () => {
  await db.insert(users).values({ sub: userSub, email: `${userSub}@example.test`, name: 'IT' })
  await db.insert(folders).values([
    { id: folderId, ownerUserId: userSub, name: 'IT folder' },
    { id: emptyFolderId, ownerUserId: userSub, name: 'IT empty folder' },
  ])
  await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT deck' })
  await db.insert(components).values({ id: componentId, folderId, name: 'IT component' })
  await db.insert(folderUpdates).values({ folderId, update: folderDocUpdate() })
})

afterAll(async () => {
  await db.delete(components).where(eq(components.id, componentId))
  await db.delete(decks).where(eq(decks.id, deckId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(folders).where(eq(folders.id, emptyFolderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await pool.end()
})

describe('createDbFolderTokensReader', () => {
  const read = createDbFolderTokensReader({ db, log: quietLog, hocuspocus: () => null })
  const expected = {
    colors: { ink: { id: 'ink', name: 'Ink', value: '#222222' } },
    textStyles: {},
    effectStyles: {},
  }

  it("reads a deck's and a component's folder from the stored folder document", async () => {
    expect(await read({ deckId })).toEqual(expected)
    expect(await read({ componentId })).toEqual(expected)
  })

  it('answers null for a folder without tokens and an unknown target', async () => {
    expect(await read({ folderId: emptyFolderId })).toBeNull()
    expect(await read({ deckId: `missing-${suffix}` })).toBeNull()
  })
})
