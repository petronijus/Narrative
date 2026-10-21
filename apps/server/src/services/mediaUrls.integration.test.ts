/**
 * services/mediaUrls.integration.test.ts — the batched URL read
 * (`MediaService.urls`, GET /api/media/urls; performance.md → L3) against a
 * real Postgres: a guest of a deck gets its own pictures, its folder's
 * component and folder pictures, never another deck's; a share link to the
 * deck gets the same; an outsider gets nothing — and each answer agrees with
 * the single `url` read, asset by asset. Excluded from `pnpm test`; run with
 * `just integration` (the docker services up).
 *
 * Creates its own users, folders, decks, component, share link and media rows
 * under random ids and deletes them afterwards (media rows cascade).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import {
  components,
  deckPermissions,
  decks,
  folderPermissions,
  folders,
  mediaAssets,
  shareLinks,
  users,
} from '../db/schema.js'
import { quietLog } from '../test-support/agentWorld.js'
import { resolveDeckAccess, resolveDecksAccess } from '../auth/permissions.js'
import { createMediaService } from './media.js'

const suffix = nanoid(8)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, 'x')
const id = (name: string) => `it-urls-${name}-${suffix}`
const owner = id('owner')
const guest = id('guest')
const outsider = id('outsider')
const folderF = id('f')
const folderG = id('g')
const deckF = id('deck-f')
const deckG = id('deck-g')
const master = id('cmp')
const token = nanoid(21)
const asset = {
  deck: id('a-deck'),
  component: id('a-cmp'),
  folder: id('a-folder'),
  otherDeck: id('a-other'),
  video: id('a-video'),
}

const media = () => createMediaService({ db, log: quietLog, hocuspocus: () => null })

beforeAll(async () => {
  await db
    .insert(users)
    .values(
      [owner, guest, outsider].map((sub) => ({ sub, email: `${sub}@example.test`, name: sub })),
    )
  await db.insert(folders).values([
    { id: folderF, ownerUserId: owner, name: 'F' },
    { id: folderG, ownerUserId: owner, name: 'G' },
  ])
  await db.insert(folderPermissions).values([
    { folderId: folderF, userId: owner, role: 'owner' },
    { folderId: folderG, userId: owner, role: 'owner' },
  ])
  await db.insert(decks).values([
    { id: deckF, title: 'In F', ownerUserId: owner, folderId: folderF },
    { id: deckG, title: 'In G', ownerUserId: owner, folderId: folderG },
  ])
  // The guest sees deck F only: as a guest of one of F's decks, F's content too.
  await db.insert(deckPermissions).values({ deckId: deckF, userId: guest, role: 'viewer' })
  await db.insert(shareLinks).values({ id: token, deckId: deckF, role: 'viewer', createdBy: owner })
  await db.insert(components).values({ id: master, folderId: folderF, name: 'Logo' })
  const row = (assetId: string, placement: Record<string, string>, width: number | null) => ({
    id: assetId,
    ...placement,
    uploaderUserId: owner,
    mimeType: 'image/jpeg',
    sizeBytes: 3,
    storageKey: `it/${assetId}/original.jpg`,
    width,
    height: width === null ? null : Math.round(width / 1.5),
    kind: 'image' as const,
  })
  await db.insert(mediaAssets).values([
    row(asset.deck, { deckId: deckF }, 3000),
    row(asset.component, { componentId: master }, 800),
    row(asset.folder, { folderId: folderF }, null),
    row(asset.otherDeck, { deckId: deckG }, 1200),
    {
      ...row(asset.video, { deckId: deckF }, 1920),
      mimeType: 'video/mp4',
      kind: 'video' as const,
    },
  ])
})

afterAll(async () => {
  await db.delete(mediaAssets).where(inArray(mediaAssets.id, Object.values(asset)))
  await db.delete(decks).where(inArray(decks.id, [deckF, deckG]))
  await db.delete(folders).where(inArray(folders.id, [folderF, folderG]))
  await db.delete(users).where(inArray(users.sub, [owner, guest, outsider]))
  await pool.end()
})

const ALL = [...Object.values(asset), id('missing')]

/** What the single read says of each asset: its URL, or null when refused / unknown. */
async function singly(caller: { userId: string | null; shareToken?: string }) {
  const out: Record<string, string | null> = {}
  for (const assetId of ALL) {
    out[assetId] = await media()
      .url({ ...caller, assetId, variant: 'medium' })
      .then((r) => r.url)
      .catch(() => null)
  }
  return out
}

describe('MediaService.urls — many assets, the rules of url', () => {
  it("answers a deck guest its deck's and its folder's pictures, sizes included, never another deck's", async () => {
    const res = await media().urls({
      userId: guest,
      assetIds: ALL,
      variants: ['medium', 'display'],
    })
    expect(Object.keys(res.assets).sort()).toEqual(
      [asset.deck, asset.component, asset.folder].sort(),
    )
    // Another deck's picture, an unknown id, and the deck's own video (images only).
    expect(res.unavailable.sort()).toEqual([asset.otherDeck, asset.video, id('missing')].sort())
    expect(res.assets[asset.deck]).toMatchObject({ width: 3000, height: 2000 })
    expect(res.assets[asset.folder]).toMatchObject({ width: null, height: null })
    expect(res.assets[asset.deck]!.urls.medium).toContain('/rs:fit:1280:1280:0/')
    expect(res.assets[asset.deck]!.urls.display).toContain('/rs:fit:2560:2560:0/')

    // Asset by asset what the single read answers.
    const single = await singly({ userId: guest })
    for (const assetId of ALL)
      expect(res.assets[assetId]?.urls.medium ?? null).toBe(single[assetId])
  })

  it('answers a share link to the deck the same, and an outsider nothing', async () => {
    const shared = await media().urls({
      userId: null,
      shareToken: token,
      assetIds: ALL,
      variants: ['medium'],
    })
    expect(Object.keys(shared.assets).sort()).toEqual(
      [asset.deck, asset.component, asset.folder].sort(),
    )
    const single = await singly({ userId: null, shareToken: token })
    for (const assetId of ALL)
      expect(shared.assets[assetId]?.urls.medium ?? null).toBe(single[assetId])

    const stranger = await media().urls({ userId: outsider, assetIds: ALL, variants: ['medium'] })
    expect(stranger.assets).toEqual({})
    expect(stranger.unavailable.sort()).toEqual([...ALL].sort())
  })

  it('answers the folder owner every picture of both folders', async () => {
    const res = await media().urls({ userId: owner, assetIds: ALL, variants: ['preview'] })
    expect(res.unavailable.sort()).toEqual([asset.video, id('missing')].sort())
    const [row] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, asset.otherDeck))
    expect(res.assets[asset.otherDeck]!.urls.preview).toContain(row!.storageKey)
  })
})

describe('resolveDecksAccess — resolveDeckAccess of many decks in one query', () => {
  it('agrees with resolveDeckAccess deck by deck, for every caller', async () => {
    const deckIds = [deckF, deckG, id('no-such-deck')]
    const callers = [
      { userId: owner },
      { userId: guest },
      { userId: outsider },
      { userId: null, shareToken: token },
      { userId: outsider, shareToken: token },
      { userId: null },
    ]
    for (const caller of callers) {
      const many = await resolveDecksAccess(db, { deckIds, ...caller })
      for (const deckId of deckIds)
        expect(many.get(deckId), `${JSON.stringify(caller)} on ${deckId}`).toEqual(
          await resolveDeckAccess(db, { deckId, ...caller }),
        )
    }
  })
})
