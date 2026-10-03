/**
 * pptx/exportDeck.test.ts — the export's asset loader is scoped to what the
 * deck may show (M6; media/visibleMedia.ts): its own media and its folder's
 * pictures and videos — the components' a stamp links, the folder's own —
 * and nothing else: an asset id that points at another deck's media is
 * skipped like a missing file, without touching storage.
 */

import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { createDeckAssetLoader, deckAssetScope } from './exportDeck.js'
import type { Database } from '../db/client.js'

const dialect = new PgDialect()
const compile = (sql: SQL) => dialect.sqlToQuery(sql)

const quietLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

/** A db whose select answers `rows` and records the WHERE it was given. */
function recordingDb(rows: unknown[]) {
  const wheres: SQL[] = []
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: (w: SQL) => {
      wheres.push(w)
      return chain
    },
    limit: async () => rows,
  }
  return { db: { select: () => chain } as unknown as Database, wheres }
}

describe('deckAssetScope', () => {
  it("is the deck's own rows, or its folder's components' and the folder's own pictures and videos", () => {
    const q = compile(deckAssetScope({ id: 'deck-1', folderId: 'folder-1' }))
    expect(q.sql).toBe(
      '("media_assets"."deck_id" = $1 or ("media_assets"."kind" in ($2, $3) and (("media_assets"."component_id" is not null and "components"."folder_id" = $4) or "media_assets"."folder_id" = $5)))',
    )
    expect(q.params).toEqual(['deck-1', 'image', 'video', 'folder-1', 'folder-1'])
  })

  it('is only the deck’s own rows for a deck without a folder', () => {
    const q = compile(deckAssetScope({ id: 'deck-1', folderId: null }))
    expect(q.sql).toBe('"media_assets"."deck_id" = $1')
    expect(q.params).toEqual(['deck-1'])
  })
})

describe('createDeckAssetLoader', () => {
  it('looks every asset up within the deck scope', async () => {
    const { db, wheres } = recordingDb([
      { storageKey: 'decks/deck-1/a.png', mimeType: 'image/png' },
    ])
    const s3 = { send: vi.fn(async () => ({ Body: Readable.from([Buffer.from('png')]) })) }
    const load = createDeckAssetLoader(
      { db, log: quietLog, s3: s3 as never },
      { id: 'deck-1', folderId: 'folder-1' },
    )
    await expect(load('asset-1')).resolves.toEqual({
      bytes: Buffer.from('png'),
      mimeType: 'image/png',
    })
    const q = compile(wheres[0]!)
    expect(q.sql).toContain('"media_assets"."id" = $1')
    expect(q.sql).toContain('"media_assets"."deck_id" = $2')
    expect(q.params).toEqual(['asset-1', 'deck-1', 'image', 'video', 'folder-1', 'folder-1'])
  })

  it('skips an asset outside the scope without reading storage, and remembers it', async () => {
    const { db, wheres } = recordingDb([])
    const s3 = { send: vi.fn() }
    const load = createDeckAssetLoader(
      { db, log: quietLog, s3: s3 as never },
      { id: 'deck-1', folderId: null },
    )
    await expect(load('someone-elses-asset')).resolves.toBeNull()
    await expect(load('someone-elses-asset')).resolves.toBeNull()
    expect(s3.send).not.toHaveBeenCalled()
    expect(wheres).toHaveLength(1)
  })
})
