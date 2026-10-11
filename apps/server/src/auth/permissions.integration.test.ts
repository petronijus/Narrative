/**
 * auth/permissions.integration.test.ts — the folder-sharing resolvers
 * (docs/plans/folder-sharing.md) against a real Postgres: a folder role
 * gives the same role on every deck and component in the folder, a deck
 * shared alone gives only that deck (plus read access to its folder's
 * tokens, fonts and component media), and services/shared.ts turns the
 * roles into 404 / 403 per operation. A deck's creator column grants
 * nothing; migration 0031 wrote it as an owner row. Excluded from `pnpm test`; run with
 * `just integration`.
 *
 * It creates its own users, folders, decks, components and share links
 * under random ids and deletes them afterwards.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { mintRenderToken, revokeRenderToken } from './renderTokens.js'
import {
  components,
  deckPermissions,
  decks,
  folderPermissions,
  folders,
  shareLinks,
  users,
} from '../db/schema.js'
import {
  resolveComponentAccess,
  resolveDeckAccess,
  resolveFolderAccess,
  resolveFolderContentAccess,
} from './permissions.js'
import { requireFolderContentReader, requireFolderRole } from '../services/shared.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-perm-${name}-${suffix}`

// Users: the folder's creator, a folder editor, a folder viewer, a guest of
// one deck, someone with nothing.
const owner = id('owner')
const editor = id('editor')
const viewer = id('viewer')
const guest = id('guest')
const stranger = id('stranger')

const folder = id('folder')
const otherFolder = id('other-folder')
const deck = id('deck')
const guestDeck = id('guest-deck')
const otherDeck = id('other-deck')
const component = id('component')
const link = id('link')
const otherLink = id('other-link')
// A deck whose creator holds no row (as decks from before M10 did), and one
// whose creator's row is lower than owner: migration 0031's two cases.
const legacyDeck = id('legacy-deck')
const demotedDeck = id('demoted-deck')
const creator = id('creator')

beforeAll(async () => {
  await db.insert(users).values(
    [owner, editor, viewer, guest, stranger].map((sub) => ({
      sub,
      email: `${sub}@example.test`,
      name: sub,
    })),
  )
  await db.insert(folders).values([
    { id: folder, ownerUserId: owner, name: 'Client' },
    { id: otherFolder, ownerUserId: owner, name: 'Other client' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: folder, userId: owner, role: 'owner' },
    { folderId: folder, userId: editor, role: 'editor', grantedBy: owner },
    { folderId: folder, userId: viewer, role: 'viewer', grantedBy: owner },
    { folderId: otherFolder, userId: owner, role: 'owner' },
  ])
  await db.insert(decks).values([
    { id: deck, title: 'Pitch', ownerUserId: owner, folderId: folder },
    { id: guestDeck, title: 'Shared alone', ownerUserId: owner, folderId: folder },
    { id: otherDeck, title: 'Elsewhere', ownerUserId: owner, folderId: otherFolder },
  ])
  await db.insert(deckPermissions).values([
    { deckId: deck, userId: owner, role: 'owner' },
    { deckId: guestDeck, userId: owner, role: 'owner' },
    { deckId: otherDeck, userId: owner, role: 'owner' },
    // The guest may edit one deck; the viewer was also given one deck as editor.
    { deckId: guestDeck, userId: guest, role: 'editor', grantedBy: owner },
    { deckId: guestDeck, userId: viewer, role: 'editor', grantedBy: owner },
  ])
  await db.insert(components).values({ id: component, folderId: folder, name: 'Logo' })
  await db.insert(shareLinks).values([
    { id: link, deckId: guestDeck, role: 'viewer', createdBy: owner },
    { id: otherLink, deckId: otherDeck, role: 'viewer', createdBy: owner },
  ])
})

afterAll(async () => {
  // Decks first (folders restrict); permissions, components and links cascade.
  await db
    .delete(decks)
    .where(inArray(decks.id, [deck, guestDeck, otherDeck, legacyDeck, demotedDeck]))
  await db.delete(folders).where(inArray(folders.id, [folder, otherFolder]))
  await db
    .delete(users)
    .where(inArray(users.sub, [owner, editor, viewer, guest, stranger, creator]))
  await pool.end()
})

describe('resolveFolderAccess', () => {
  it('is the member row, and nothing for anyone else', async () => {
    const role = async (userId: string | null) =>
      (await resolveFolderAccess(db, { folderId: folder, userId }))?.role ?? null
    expect(await role(owner)).toBe('owner')
    expect(await role(editor)).toBe('editor')
    expect(await role(viewer)).toBe('viewer')
    expect(await role(guest)).toBeNull()
    expect(await role(stranger)).toBeNull()
    expect(await role(null)).toBeNull()
  })

  it('takes the highest role over `alsoAs`', async () => {
    const access = await resolveFolderAccess(db, {
      folderId: folder,
      userId: viewer,
      alsoAs: [editor],
    })
    expect(access?.role).toBe('editor')
  })
})

describe('resolveDeckAccess', () => {
  it('gives a folder member their folder role on every deck in the folder', async () => {
    expect(await resolveDeckAccess(db, { deckId: deck, userId: editor })).toEqual({
      role: 'editor',
      reason: 'folder',
    })
    expect(await resolveDeckAccess(db, { deckId: deck, userId: viewer })).toEqual({
      role: 'viewer',
      reason: 'folder',
    })
    // A member of one folder has nothing on another folder's deck.
    expect(await resolveDeckAccess(db, { deckId: otherDeck, userId: editor })).toBeNull()
  })

  it('takes the higher of a deck grant and the folder role', async () => {
    // viewer in the folder, editor on this one deck
    expect(await resolveDeckAccess(db, { deckId: guestDeck, userId: viewer })).toEqual({
      role: 'editor',
      reason: 'direct',
    })
    // the owner's own deck row and folder row are both owner
    expect((await resolveDeckAccess(db, { deckId: deck, userId: owner }))?.role).toBe('owner')
  })

  it('gives a deck guest that deck only', async () => {
    expect((await resolveDeckAccess(db, { deckId: guestDeck, userId: guest }))?.role).toBe('editor')
    expect(await resolveDeckAccess(db, { deckId: deck, userId: guest })).toBeNull()
    expect(await resolveDeckAccess(db, { deckId: deck, userId: stranger })).toBeNull()
  })

  it('answers a share link for its own deck only', async () => {
    expect(
      await resolveDeckAccess(db, { deckId: guestDeck, userId: null, shareToken: link }),
    ).toEqual({ role: 'viewer', reason: 'share-link' })
    expect(await resolveDeckAccess(db, { deckId: deck, userId: null, shareToken: link })).toBeNull()
  })
})

describe('the creator of a deck (decks.owner_user_id)', () => {
  const migration0031 = readFileSync(
    fileURLToPath(new URL('../../drizzle/0031_deck_creator_grants.sql', import.meta.url)),
    'utf8',
  )

  it('grants nothing by itself; migration 0031 turns it into an owner row, idempotently', async () => {
    await db.insert(users).values({ sub: creator, email: `${creator}@example.test`, name: 'c' })
    await db.insert(decks).values([
      { id: legacyDeck, title: 'Before M10', ownerUserId: creator, folderId: otherFolder },
      { id: demotedDeck, title: 'Demoted', ownerUserId: creator, folderId: otherFolder },
    ])
    await db
      .insert(deckPermissions)
      .values({ deckId: demotedDeck, userId: creator, role: 'viewer', grantedBy: owner })

    // No fallback: the creator column is a record, not a grant.
    expect(await resolveDeckAccess(db, { deckId: legacyDeck, userId: creator })).toBeNull()
    expect(
      await resolveFolderContentAccess(db, { folderId: otherFolder, userId: creator }),
    ).toEqual({ role: 'viewer', via: 'deck' }) // through the viewer row on the demoted deck

    for (let run = 0; run < 2; run++) {
      await pool.query(migration0031)
      expect(await resolveDeckAccess(db, { deckId: legacyDeck, userId: creator })).toEqual({
        role: 'owner',
        reason: 'direct',
      })
      expect((await resolveDeckAccess(db, { deckId: demotedDeck, userId: creator }))?.role).toBe(
        'owner',
      )
    }
    // Every other deck's rows are untouched: the owner still owns, the guest still edits.
    expect((await resolveDeckAccess(db, { deckId: guestDeck, userId: guest }))?.role).toBe('editor')
  })
})

describe('resolveComponentAccess', () => {
  it('is the folder role; a deck guest does not see the folder’s components', async () => {
    const role = async (userId: string) =>
      (await resolveComponentAccess(db, { componentId: component, userId }))?.role ?? null
    expect(await role(owner)).toBe('owner')
    expect(await role(editor)).toBe('editor')
    expect(await role(viewer)).toBe('viewer')
    expect(await role(guest)).toBeNull()
    expect(await role(stranger)).toBeNull()
  })
})

describe('a component master’s render token (agentic A3.5)', () => {
  it('reads that master and its folder, read-only, only while its requester can', async () => {
    const token = mintRenderToken({ kind: 'component', id: component }, viewer)
    try {
      expect(
        await resolveComponentAccess(db, {
          componentId: component,
          userId: null,
          shareToken: token,
        }),
      ).toEqual({ role: 'viewer', reason: 'render' })
      expect(
        await resolveFolderContentAccess(db, { folderId: folder, userId: null, shareToken: token }),
      ).toEqual({ role: 'viewer', via: 'render' })
      // Nothing else: another folder, any deck — it is no share link.
      expect(
        await resolveFolderContentAccess(db, {
          folderId: otherFolder,
          userId: null,
          shareToken: token,
        }),
      ).toBeNull()
      expect(
        await resolveDeckAccess(db, { deckId: deck, userId: null, shareToken: token }),
      ).toBeNull()
    } finally {
      revokeRenderToken(token)
    }
  })

  it('opens nothing once revoked, nor for a requester outside the folder', async () => {
    const outsider = mintRenderToken({ kind: 'component', id: component }, guest)
    const ended = mintRenderToken({ kind: 'component', id: component }, editor)
    revokeRenderToken(ended)
    try {
      for (const token of [outsider, ended]) {
        expect(
          await resolveComponentAccess(db, {
            componentId: component,
            userId: null,
            shareToken: token,
          }),
        ).toBeNull()
        expect(
          await resolveFolderContentAccess(db, {
            folderId: folder,
            userId: null,
            shareToken: token,
          }),
        ).toBeNull()
      }
      // A deck's render token never reaches a master.
      const deckToken = mintRenderToken({ kind: 'deck', id: deck }, owner)
      expect(
        await resolveComponentAccess(db, {
          componentId: component,
          userId: null,
          shareToken: deckToken,
        }),
      ).toBeNull()
      revokeRenderToken(deckToken)
    } finally {
      revokeRenderToken(outsider)
    }
  })
})

describe('resolveFolderContentAccess', () => {
  it('lets members read with their role and deck guests read as viewers', async () => {
    const access = async (userId: string | null, shareToken?: string) =>
      resolveFolderContentAccess(db, { folderId: folder, userId, shareToken: shareToken ?? null })
    expect(await access(editor)).toEqual({ role: 'editor', via: 'folder' })
    expect(await access(guest)).toEqual({ role: 'viewer', via: 'deck' })
    expect(await access(null, link)).toEqual({ role: 'viewer', via: 'deck' })
    expect(await access(stranger)).toBeNull()
    // A share link to another folder's deck opens nothing here.
    expect(await access(null, otherLink)).toBeNull()
    expect(await access(null)).toBeNull()
  })

  it('counts a deck guest’s `alsoAs` ids (BYPASS_AUTH’s demo user)', async () => {
    expect(
      await resolveFolderContentAccess(db, { folderId: folder, userId: stranger, alsoAs: [guest] }),
    ).toEqual({ role: 'viewer', via: 'deck' })
  })

  it('stops at an expired share link', async () => {
    const expired = id('expired')
    await db.insert(shareLinks).values({
      id: expired,
      deckId: guestDeck,
      role: 'viewer',
      createdBy: owner,
      expiresAt: new Date(Date.now() - 60_000),
    })
    expect(
      await resolveFolderContentAccess(db, { folderId: folder, userId: null, shareToken: expired }),
    ).toBeNull()
    expect(
      await resolveDeckAccess(db, { deckId: guestDeck, userId: null, shareToken: expired }),
    ).toBeNull()
  })

  it('stops at a revoked share link', async () => {
    const revoked = id('revoked')
    await db
      .insert(shareLinks)
      .values({ id: revoked, deckId: guestDeck, role: 'viewer', createdBy: owner, revoked: true })
    expect(
      await resolveFolderContentAccess(db, { folderId: folder, userId: null, shareToken: revoked }),
    ).toBeNull()
  })
})

describe('requireFolderRole / requireFolderContentReader', () => {
  it('answers 404 for a missing folder and 403 for a non-member', async () => {
    await expect(requireFolderRole(db, id('missing'), owner, 'viewer')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(requireFolderRole(db, folder, stranger, 'viewer')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Forbidden',
    })
    // A deck guest is not a member.
    await expect(requireFolderRole(db, folder, guest, 'viewer')).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('refuses a member whose role is too low, saying which role it needs', async () => {
    await expect(requireFolderRole(db, folder, viewer, 'editor')).rejects.toMatchObject({
      code: 'forbidden',
      message: 'Forbidden: this needs the editor role in the folder',
    })
    await expect(requireFolderRole(db, folder, editor, 'owner')).rejects.toMatchObject({
      code: 'forbidden',
      message: "Forbidden: only the folder's owner may do this",
    })
    expect((await requireFolderRole(db, folder, editor, 'editor')).role).toBe('editor')
    expect(await requireFolderRole(db, folder, owner, 'owner')).toMatchObject({
      id: folder,
      name: 'Client',
      role: 'owner',
    })
  })

  it('lets a deck guest read the folder’s shared content, and nobody else', async () => {
    expect(await requireFolderContentReader(db, folder, guest)).toEqual({
      role: 'viewer',
      via: 'deck',
    })
    await expect(requireFolderContentReader(db, folder, stranger)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(requireFolderContentReader(db, id('missing'), owner)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
