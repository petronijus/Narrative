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
import {
  createDeckAssetLoader,
  deckAssetScope,
  resolveSlideTokens,
  safeFilename,
} from './exportDeck.js'
import type { Slide } from '@narrative/shared'
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
    const source = await load('asset-1')
    expect(source).toMatchObject({ mimeType: 'image/png' })
    // Each open is a fresh read of the stored object (the writer reads twice).
    for (let i = 0; i < 2; i++) {
      const chunks: Uint8Array[] = []
      for await (const c of await (
        source as { open: () => Promise<AsyncIterable<Uint8Array>> }
      ).open())
        chunks.push(c)
      expect(Buffer.concat(chunks).toString()).toBe('png')
    }
    expect(s3.send).toHaveBeenCalledTimes(2)
    await load('asset-1')
    expect(wheres).toHaveLength(1)
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

describe('resolveSlideTokens (A4.2d)', () => {
  const tokens = {
    colors: {
      text: {
        id: 'text',
        name: 'Text',
        value: '#001e50',
        byVariant: { axis: 'background', values: { dc: '#ffffff' } },
        bySurface: { band: '#ff0000' },
      },
      muted: { id: 'muted', name: 'Muted', value: '#00000080' },
    },
    textStyles: {},
    effectStyles: {},
  }
  const slide = (surface?: string): Slide =>
    ({
      id: 's',
      objects: [
        { id: 'a', type: 'rectangle', fill: { $token: 'colors.text' }, fillAlpha: 1 },
        { id: 'b', type: 'rectangle', fill: { $token: 'colors.muted' }, fillAlpha: 0.5 },
      ],
      animations: [],
      transition: { kind: 'none', durationMs: 0 },
      ...(surface !== undefined ? { layout: { packId: 'p', layoutId: 'l', surface } } : {}),
    }) as unknown as Slide

  it('resolves on the deck variant and the slide surface, and multiplies token alpha in', () => {
    const plain = resolveSlideTokens(slide(), tokens).objects as unknown as Array<
      Record<string, unknown>
    >
    expect(plain[0]!['fill']).toBe(0x001e50)
    expect(plain[1]).toMatchObject({ fill: 0x000000, fillAlpha: 0.251 })
    const dc = resolveSlideTokens(slide(), tokens, { background: 'dc' })
      .objects as unknown as Array<Record<string, unknown>>
    expect(dc[0]!['fill']).toBe(0xffffff)
    const band = resolveSlideTokens(slide('band'), tokens, { background: 'dc' })
      .objects as unknown as Array<Record<string, unknown>>
    expect(band[0]!['fill']).toBe(0xff0000)
  })
})

describe('safeFilename', () => {
  it('drops what could make a download name lie about its kind', () => {
    expect(safeFilename('invoice\u202Efdp.exe')).toBe('invoice fdp.exe')
    expect(safeFilename('Q3 / "review"\n')).toBe('Q3 review')
    expect(safeFilename('   ')).toBe('deck')
  })
})
