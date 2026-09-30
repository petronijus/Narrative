/**
 * services/listPage.integration.test.ts — `DeckService.listPage` and
 * `FolderService.listPage` (the agent's `deck.list` / `folder.list`) against
 * a real Postgres: the SQL keyset, the "last change" sort that counts
 * document stores, microsecond keys, literal (escaped) title search, access
 * through deck_permissions and through folder membership (folder_permissions,
 * the higher role winning), and the BYPASS_AUTH owner set. Excluded from
 * `pnpm test`; run with `pnpm --filter @narrative/server test:integration`.
 *
 * It creates its own users, folders and decks under random ids and deletes
 * them afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { FastifyBaseLogger } from 'fastify'
import type { DeckListItem, ListKeyset } from '@narrative/commands'
import { db, pool } from '../db/client.js'
import {
  deckPermissions,
  deckUpdates,
  decks,
  folderPermissions,
  folders,
  users,
} from '../db/schema.js'
import { createDecksService } from './decks.js'
import { createFoldersService } from './folders.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const me = `it-lp-me-${suffix}`
const other = `it-lp-other-${suffix}`
const f = (name: string) => `it-lp-${name}-${suffix}`
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger
const deckService = createDecksService({ db, log, hocuspocus: () => null })
const folderService = createFoldersService({ db, log, hocuspocus: () => null })

const ts = (value: string) => sql`${value}::timestamp`

// Deck id → [title, folder, updated_at, last document store or null, my deck grant or null].
const DECKS: Record<string, [string, string, string, string | null, 'owner' | 'viewer' | null]> = {
  a: ['Alpha review', f('one'), '2026-01-01 10:00:00.000001', null, 'owner'],
  // Same millisecond as `a`, one microsecond later: must sort before it.
  b: ['Beta 100% plan', f('one'), '2026-01-01 10:00:00.000002', null, 'owner'],
  // Old record, but its content was stored last: must come first.
  c: ['Gamma_notes', f('two'), '2025-06-01 09:00:00.000000', '2026-03-01 08:00:00.500000', 'owner'],
  d: ['Delta', f('two'), '2026-02-01 12:00:00.000000', '2025-01-01 00:00:00.000000', 'owner'],
  // Another user's deck shared with me as viewer.
  e: ['Shared deck', f('theirs'), '2026-01-15 00:00:00.000000', null, 'viewer'],
  // Another user's deck I cannot see.
  x: ['Hidden', f('theirs'), '2026-04-01 00:00:00.000000', null, null],
  // Another user's folder shared with me as editor: I see its decks with my
  // folder role, a deck grant below it notwithstanding.
  s: ['Through the folder', f('shared'), '2025-03-01 00:00:00.000000', null, null],
  t: ['Viewer grant, editor folder', f('shared'), '2025-02-01 00:00:00.000000', null, 'viewer'],
}
/** The folders the other user created. */
const THEIRS = new Set([f('theirs'), f('shared')])
const deckId = (k: string) => `it-lp-deck-${k}-${suffix}`

beforeAll(async () => {
  await db.insert(users).values([
    { sub: me, email: `${me}@example.test`, name: 'Me' },
    { sub: other, email: `${other}@example.test`, name: 'Other' },
  ])
  await db.insert(folders).values([
    { id: f('one'), ownerUserId: me, name: 'client one' },
    { id: f('two'), ownerUserId: me, name: 'Client_Two' },
    { id: f('three'), ownerUserId: me, name: 'Brand 50%' },
    { id: f('theirs'), ownerUserId: other, name: 'Theirs' },
    { id: f('shared'), ownerUserId: other, name: 'Shared with me' },
  ])
  // Each creator owns their folder (as services/folders.ts create writes it);
  // `shared` is shared with me as editor.
  await db.insert(folderPermissions).values([
    { folderId: f('one'), userId: me, role: 'owner' },
    { folderId: f('two'), userId: me, role: 'owner' },
    { folderId: f('three'), userId: me, role: 'owner' },
    { folderId: f('theirs'), userId: other, role: 'owner' },
    { folderId: f('shared'), userId: other, role: 'owner' },
    { folderId: f('shared'), userId: me, role: 'editor', grantedBy: other },
  ])
  for (const [k, [title, folderId, updatedAt, stored, role]] of Object.entries(DECKS)) {
    const owner = THEIRS.has(folderId) ? other : me
    await db.insert(decks).values({
      id: deckId(k),
      title,
      ownerUserId: owner,
      folderId,
      createdAt: ts(updatedAt),
      updatedAt: ts(updatedAt),
    })
    await db.insert(deckPermissions).values({ deckId: deckId(k), userId: owner, role: 'owner' })
    if (role === 'viewer')
      await db.insert(deckPermissions).values({ deckId: deckId(k), userId: me, role: 'viewer' })
    if (stored !== null)
      await db.insert(deckUpdates).values({
        deckId: deckId(k),
        update: Buffer.from([0, 0]),
        createdAt: ts(stored),
      })
  }
})

afterAll(async () => {
  await db.delete(decks).where(
    inArray(
      decks.id,
      Object.keys(DECKS).map((k) => deckId(k)),
    ),
  )
  // folder_permissions cascade with their folders.
  await db
    .delete(folders)
    .where(inArray(folders.id, [f('one'), f('two'), f('three'), f('theirs'), f('shared')]))
  await db.delete(users).where(inArray(users.sub, [me, other]))
  await pool.end()
})

async function allDecks(
  args: { folderId?: string; query?: string },
  limit: number,
): Promise<DeckListItem[]> {
  const out: DeckListItem[] = []
  let after: ListKeyset | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = await deckService.listPage({ userId: me, ...args, limit, after })
    expect(page.decks.length).toBeLessThanOrEqual(limit)
    out.push(...page.decks)
    if (page.next === null) return out
    after = page.next
  }
  throw new Error('paging did not end')
}

describe('DeckService.listPage', () => {
  it('lists what I can open, newest change first — counting document stores — at microsecond precision', async () => {
    const page = await deckService.listPage({ userId: me, limit: 50 })
    expect(page.next).toBeNull()
    expect(page.decks.map((d) => d.id)).toEqual(['c', 'd', 'e', 'b', 'a', 's', 't'].map(deckId))
    const c = page.decks[0]!
    expect(c).toEqual({
      id: deckId('c'),
      title: 'Gamma_notes',
      folderId: f('two'),
      updatedAt: '2026-03-01T08:00:00.500Z',
      role: 'owner',
    })
    expect(page.decks.find((d) => d.id === deckId('e'))?.role).toBe('viewer')
  })

  it('shows every deck of a folder shared with me, with the higher of my folder role and deck grant', async () => {
    const page = await deckService.listPage({ userId: me, limit: 50, folderId: f('shared') })
    expect(page.decks.map((d) => [d.id, d.role])).toEqual([
      [deckId('s'), 'editor'],
      [deckId('t'), 'editor'],
    ])
    // The same rule in the web app's list.
    const listed = await deckService.list({ userId: me, folderId: f('shared') })
    expect(listed.map((d) => [d.id, d.viewerRole])).toEqual([
      [deckId('t'), 'editor'],
      [deckId('s'), 'editor'],
    ])
    // A deck shared alone does not open its folder.
    const all = await deckService.list({ userId: me })
    expect(all.map((d) => d.id)).not.toContain(deckId('x'))
  })

  it('pages with the keyset without repeating or skipping, whatever the page size', async () => {
    const expected = ['c', 'd', 'e', 'b', 'a', 's', 't'].map(deckId)
    for (const limit of [1, 2, 3, 5, 7]) {
      expect((await allDecks({}, limit)).map((d) => d.id)).toEqual(expected)
    }
    const first = await deckService.listPage({ userId: me, limit: 4 })
    expect(first.next).toEqual({ key: '2026-01-01T10:00:00.000002', id: deckId('b') })
  })

  it('matches the title literally, ignoring case (% and _ are not wildcards)', async () => {
    const ids = async (query: string) => (await allDecks({ query }, 2)).map((d) => d.id)
    expect(await ids('100%')).toEqual([deckId('b')])
    expect(await ids('%')).toEqual([deckId('b')])
    expect(await ids('a_n')).toEqual([deckId('c')])
    expect(await ids('_')).toEqual([deckId('c')])
    expect(await ids('ALPHA')).toEqual([deckId('a')])
    expect(await ids('hidden')).toEqual([])
  })

  it('filters by one of my folders, and refuses someone else’s', async () => {
    expect((await allDecks({ folderId: f('two') }, 1)).map((d) => d.id)).toEqual(
      ['c', 'd'].map(deckId),
    )
    await expect(
      deckService.listPage({ userId: me, folderId: f('theirs'), limit: 10 }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      deckService.listPage({ userId: me, folderId: f('missing'), limit: 10 }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses a malformed keyset and an out-of-range limit before querying', async () => {
    await expect(
      deckService.listPage({ userId: me, limit: 10, after: { key: "'; drop", id: 'x' } }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(deckService.listPage({ userId: me, limit: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(deckService.listPage({ userId: me, limit: 201 })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('in BYPASS_AUTH mode lists the dev owners’ decks as owner', async () => {
    const bypass = createDecksService({ db, log, hocuspocus: () => null, bypass: true })
    const page = await bypass.listPage({ userId: 'dev-user', limit: 200, query: suffix })
    // None of this test's decks belong to dev-user / demo-user.
    expect(page.decks).toEqual([])
    const any = await bypass.listPage({ userId: 'dev-user', limit: 1 })
    for (const d of any.decks) expect(d.role).toBe('owner')
  })
})

describe('FolderService.listPage', () => {
  it('lists my folders by name ignoring case, pages, and matches literally', async () => {
    const mine = [f('three'), f('one'), f('two')] // "Brand 50%", "client one", "Client_Two"
    const names: string[] = []
    let after: ListKeyset | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await folderService.listPage({ userId: me, limit: 1, after })
      names.push(...page.folders.map((x) => x.id))
      if (page.next === null) break
      after = page.next
    }
    // The user may own other folders only if a previous run leaked them; ours are in order.
    expect(names.filter((id) => mine.includes(id))).toEqual(mine)

    const byQuery = async (query: string) =>
      (await folderService.listPage({ userId: me, limit: 50, query })).folders.map((x) => x.id)
    expect(await byQuery('50%')).toEqual([f('three')])
    expect(await byQuery('t_o')).toEqual([]) // as a wildcard it would match "client one"
    expect(await byQuery('_two')).toEqual([f('two')])
    const one = (await folderService.listPage({ userId: me, limit: 50, query: 'CLIENT ONE' }))
      .folders[0]
    expect(one).toMatchObject({ id: f('one'), name: 'client one', deckCount: 2, role: 'owner' })
  })

  it('lists a folder shared with me with my role in it, and never one that is not', async () => {
    const byId = new Map(
      (await folderService.list({ userId: me })).map((x) => [x.id, x.role] as const),
    )
    expect(byId.get(f('shared'))).toBe('editor')
    expect(byId.get(f('one'))).toBe('owner')
    expect(byId.has(f('theirs'))).toBe(false)
    const shared = (await folderService.listPage({ userId: me, limit: 50, query: 'shared with' }))
      .folders
    expect(shared).toEqual([
      {
        id: f('shared'),
        name: 'Shared with me',
        createdAt: expect.any(String),
        deckCount: 2,
        role: 'editor',
      },
    ])
  })

  it('takes the highest role when one person holds several rows (BYPASS_AUTH’s demo user)', async () => {
    // The enum is declared owner, editor, viewer: `min(role)` must mean the
    // highest role, not the alphabetically first.
    await db
      .insert(folderPermissions)
      .values({ folderId: f('shared'), userId: 'demo-user', role: 'owner' })
    try {
      const bypass = createFoldersService({ db, log, hocuspocus: () => null, bypass: true })
      const listed = await bypass.list({ userId: me })
      expect(listed.filter((x) => x.id === f('shared'))).toEqual([
        expect.objectContaining({ role: 'owner' }),
      ])
      const paged = await bypass.listPage({ userId: me, limit: 50, query: 'shared with' })
      expect(paged.folders.map((x) => [x.id, x.role])).toEqual([[f('shared'), 'owner']])
    } finally {
      await db
        .delete(folderPermissions)
        .where(
          and(
            eq(folderPermissions.folderId, f('shared')),
            eq(folderPermissions.userId, 'demo-user'),
          ),
        )
    }
  })
})
