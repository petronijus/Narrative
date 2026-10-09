/**
 * agent/access.integration.test.ts — whom the agent host lets run a
 * folder-scoped command (folder sharing step 4): a folder MEMBER, with their
 * folder role. A guest of one of the folder's decks is no member — but reads
 * the folder's tokens and fonts in the editor, so for the commands that read
 * exactly that (`folderReaders: 'content'`: token.list, folder.fonts.list,
 * media.fontUrl) their agent is a viewer too. A share link never counts.
 * Against a real Postgres; excluded from `pnpm test`, run with
 * `just integration`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { deckPermissions, decks, folderPermissions, folders, shareLinks } from '../db/schema.js'
import { resolveFolderContentAccess } from '../auth/permissions.js'
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
const stranger = id('stranger')
const link = id('link')

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
  // A live share link to the deck: it admits an anonymous browser, never an agent.
  await db.insert(shareLinks).values({ id: link, deckId: deck, role: 'editor', createdBy: owner })
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

describe('the agent host’s role as a reader of the folder’s content', () => {
  const access = createDbAccess(db)

  it('is a member’s folder role', async () => {
    expect(await access.folderContentRole(folder, owner)).toBe('owner')
    expect(await access.folderContentRole(folder, viewer)).toBe('viewer')
  })

  it('is viewer for a guest of one of its decks, whatever their deck role', async () => {
    expect(await access.folderContentRole(folder, guest)).toBe('viewer')
  })

  it('is none for anyone else — a share link to one of its decks does not count', async () => {
    // The live link would let its holder read the folder's content in a
    // browser; the agent host never passes one, so the same person gets nothing.
    expect(
      await resolveFolderContentAccess(db, {
        folderId: folder,
        userId: stranger,
        shareToken: link,
      }),
    ).toEqual({ role: 'viewer', via: 'deck' })
    expect(await access.folderContentRole(folder, stranger)).toBeNull()
  })
})
