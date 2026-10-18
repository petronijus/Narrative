/**
 * services/deckRecordsPage.integration.test.ts — `DeckService.listRecordsPage`
 * (GET /decks?limit=&cursor=) against a real Postgres: the pages put together
 * are exactly `list` — same records, same order (created, then id), decks
 * created in the same microsecond included — for every page size, with and
 * without a folder filter, through deck grants and folder membership; a
 * malformed key is refused. Excluded from `pnpm test`; run with
 * `just integration`. Creates its own rows under random ids and deletes them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { FastifyBaseLogger } from 'fastify'
import type { DeckWithRole, ListKeyset } from '@narrative/commands'
import { db, pool } from '../db/client.js'
import { deckPermissions, decks, folderPermissions, folders, users } from '../db/schema.js'
import { createDecksService } from './decks.js'
import { DEV_USER_SUB } from '../auth/devIdentity.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const me = `it-rp-me-${suffix}`
const other = `it-rp-other-${suffix}`
const f = (name: string) => `it-rp-${name}-${suffix}`
const deckId = (k: string) => `it-rp-deck-${k}-${suffix}`
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger
const service = createDecksService({ db, log, hocuspocus: () => null })
const ts = (value: string) => sql`${value}::timestamp`

// Deck → [folder, created_at, my deck grant (null: through the folder or not at all)].
const DECKS: Record<string, [string, string, 'viewer' | null]> = {
  a: [f('mine'), '2026-01-01 10:00:00.000001', null],
  // The same microsecond as `c`: ordered by id (deck-b before deck-c).
  b: [f('mine'), '2026-01-01 10:00:00.000002', null],
  c: [f('mine'), '2026-01-01 10:00:00.000002', null],
  d: [f('mine'), '2025-12-31 23:59:59.999999', null],
  e: [f('other'), '2026-02-01 00:00:00.000000', null],
  // Another user's deck shared with me.
  g: [f('theirs'), '2026-01-15 00:00:00.000000', 'viewer'],
  // Another user's deck I cannot see.
  x: [f('theirs'), '2026-01-20 00:00:00.000000', null],
}

beforeAll(async () => {
  await db.insert(users).values([
    { sub: me, email: `${me}@example.test`, name: 'Me' },
    { sub: other, email: `${other}@example.test`, name: 'Other' },
  ])
  await db.insert(folders).values([
    { id: f('mine'), ownerUserId: me, name: 'Mine' },
    { id: f('other'), ownerUserId: me, name: 'Other of mine' },
    { id: f('theirs'), ownerUserId: other, name: 'Theirs' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: f('mine'), userId: me, role: 'owner' },
    { folderId: f('other'), userId: me, role: 'owner' },
    { folderId: f('theirs'), userId: other, role: 'owner' },
  ])
  for (const [k, [folderId, created, grant]] of Object.entries(DECKS)) {
    const owner = folderId === f('theirs') ? other : me
    await db.insert(decks).values({
      id: deckId(k),
      title: `Deck ${k}`,
      ownerUserId: owner,
      folderId,
      createdAt: ts(created),
      updatedAt: ts(created),
    })
    await db.insert(deckPermissions).values({ deckId: deckId(k), userId: owner, role: 'owner' })
    if (grant !== null)
      await db.insert(deckPermissions).values({ deckId: deckId(k), userId: me, role: grant })
  }
})

afterAll(async () => {
  await db.delete(decks).where(
    inArray(
      decks.id,
      Object.keys(DECKS).map((k) => deckId(k)),
    ),
  )
  await db.delete(folders).where(inArray(folders.id, [f('mine'), f('other'), f('theirs')]))
  await db.delete(users).where(inArray(users.sub, [me, other]))
  await pool.end()
})

async function allPages(
  svc: typeof service,
  userId: string,
  folderId: string | undefined,
  limit: number,
): Promise<DeckWithRole[]> {
  const out: DeckWithRole[] = []
  let after: ListKeyset | undefined
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await svc.listRecordsPage({ userId, folderId, limit, after })
    expect(page.decks.length).toBeLessThanOrEqual(limit)
    out.push(...page.decks)
    if (page.next === null) return out
    expect(page.decks).toHaveLength(limit)
    after = page.next
  }
  throw new Error('paging did not end')
}

const mineOnly = (list: DeckWithRole[]) => list.filter((d) => d.id.endsWith(suffix))

describe('DeckService.listRecordsPage', () => {
  it('pages through exactly what list answers, in its order, for every page size', async () => {
    const whole = mineOnly(await service.list({ userId: me }))
    expect(whole.map((d) => d.id)).toEqual(['d', 'a', 'b', 'c', 'g', 'e'].map(deckId))
    for (const limit of [1, 2, 3, 5, 6, 7, 200]) {
      expect(mineOnly(await allPages(service, me, undefined, limit))).toEqual(whole)
    }
  })

  it('pages within one folder, and keeps the roles list gives', async () => {
    const whole = await service.list({ userId: me, folderId: f('mine') })
    expect(whole.map((d) => d.id)).toEqual(['d', 'a', 'b', 'c'].map(deckId))
    expect(await allPages(service, me, f('mine'), 3)).toEqual(whole)
    const shared = (await allPages(service, me, undefined, 2)).find((d) => d.id === deckId('g'))
    expect(shared?.viewerRole).toBe('viewer')
  })

  it('refuses a malformed position and a page size out of range', async () => {
    for (const key of ["x' or 1=1", '2026-13-01T00:00:00.000000', '2026-02-30T10:00:00.000000'])
      await expect(
        service.listRecordsPage({ userId: me, limit: 2, after: { key, id: 'a' } }),
      ).rejects.toMatchObject({ status: 400 })
    // listPage (deck.list) takes the same keys.
    await expect(
      service.listPage({
        userId: me,
        limit: 2,
        after: { key: '2026-02-30T10:00:00.000000', id: 'a' },
      }),
    ).rejects.toMatchObject({ status: 400 })
    for (const limit of [0, 201, 1.5])
      await expect(service.listRecordsPage({ userId: me, limit })).rejects.toMatchObject({
        status: 400,
      })
  })

  it("pages the dev user's decks in BYPASS_AUTH mode the same way", async () => {
    const bypass = createDecksService({ db, log, hocuspocus: () => null, bypass: true })
    const whole = await bypass.list({ userId: DEV_USER_SUB })
    expect(await allPages(bypass, DEV_USER_SUB, undefined, 200)).toEqual(whole)
  })
})
