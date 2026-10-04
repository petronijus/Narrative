/**
 * agent/access.integration.test.ts — whom the agent host lets run a
 * folder-scoped command (folder sharing step 4): a folder MEMBER, with their
 * folder role. A guest of one of the folder's decks reads the folder's tokens
 * and fonts through that deck in the editor, but is no member: their agent
 * gets no folder role (the commands token.list, folder.fonts.list,
 * media.fontUrl… are refused before they run). Against a real Postgres;
 * excluded from `pnpm test`, run with `just integration`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { deckPermissions, decks, folderPermissions, folders } from '../db/schema.js'
import { createDbAccess } from './access.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-access-${name}-${suffix}`
const owner = id('owner')
const viewer = id('viewer')
const guest = id('guest')
const folder = id('folder')
const deck = id('deck')

beforeAll(async () => {
  await db.insert(folders).values({ id: folder, ownerUserId: owner, name: 'Client' })
  await db.insert(folderPermissions).values([
    { folderId: folder, userId: owner, role: 'owner' },
    { folderId: folder, userId: viewer, role: 'viewer', grantedBy: owner },
  ])
  await db.insert(decks).values({ id: deck, title: 'Pitch', ownerUserId: owner, folderId: folder })
  await db.insert(deckPermissions).values([
    { deckId: deck, userId: owner, role: 'owner', grantedBy: owner },
    // A guest of this one deck, with the editor role on it.
    { deckId: deck, userId: guest, role: 'editor', grantedBy: owner },
  ])
})

afterAll(async () => {
  await db.delete(decks).where(inArray(decks.id, [deck]))
  await db.delete(folders).where(inArray(folders.id, [folder]))
  await pool.end()
})

describe('the agent host’s folder role', () => {
  const access = createDbAccess(db)

  it('is a member’s folder role', async () => {
    expect(await access.folderRole(folder, owner)).toBe('owner')
    expect(await access.folderRole(folder, viewer)).toBe('viewer')
  })

  it('is none for a guest of one of its decks, who keeps their deck role', async () => {
    expect(await access.folderRole(folder, guest)).toBeNull()
    expect(await access.deckRole(deck, guest)).toBe('editor')
  })
})
