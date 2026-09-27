/**
 * Paging of `deck.list` / `folder.list`: the cursor codec, and the commands
 * walking the fixture world page by page through the in-memory services
 * (the SQL keyset itself is tested against Postgres in apps/server,
 * services/listPage.integration.test.ts).
 */

import { describe, expect, it } from 'vitest'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import { createDefaultRegistry } from '../catalog.js'
import { runCommand } from '../run.js'
import { CommandError } from '../errors.js'
import { createFixtureDeck } from '../testing/fixtureDeck.js'
import {
  FIXTURE_DECK_ID,
  FIXTURE_FOLDER_ID,
  createFakeServices,
  type FakeServices,
} from '../testing/fakeServices.js'
import type { CommandContext } from '../types.js'
import { decodeListCursor, encodeListCursor } from './listPaging.js'

const registry = createDefaultRegistry()

function ctx(): CommandContext & { services: FakeServices } {
  return {
    actor: { userId: 'u1', role: 'owner', kind: 'agent' },
    host: 'server',
    origin: LOCAL_ORIGIN,
    deck: createFixtureDeck(),
    target: { deckId: FIXTURE_DECK_ID, folderId: FIXTURE_FOLDER_ID },
    services: createFakeServices(),
  } as CommandContext & { services: FakeServices }
}

async function failure(p: Promise<unknown>): Promise<CommandError> {
  try {
    await p
  } catch (e) {
    if (e instanceof CommandError) return e
    throw e
  }
  throw new Error('expected a CommandError')
}

describe('list cursors', () => {
  const filter = { query: 'Q3 — Přehled', folderId: null }

  it('round-trip a keyset, also with non-Latin text in keys and filters', () => {
    const keyset = { key: '2026-09-26T10:00:00.123456', id: 'deck_ž' }
    const cursor = encodeListCursor('deck', keyset, filter)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeListCursor('deck', cursor, filter)).toEqual(keyset)
  })

  it('refuse garbage, truncated cursors and the other list’s cursors with invalid_input', () => {
    const cursor = encodeListCursor('deck', { key: 'k', id: 'i' }, filter)
    for (const bad of ['not a cursor!', 'e30', cursor.slice(0, -3), '%%%']) {
      const e = (() => {
        try {
          decodeListCursor('deck', bad, filter)
        } catch (err) {
          return err
        }
        return null
      })()
      expect(e, bad).toBeInstanceOf(CommandError)
      expect((e as CommandError).code).toBe('invalid_input')
      expect((e as CommandError).issues[0]?.path).toEqual(['cursor'])
    }
    expect(() => decodeListCursor('folder', cursor, { query: filter.query })).toThrow(
      /belongs to deck\.list/,
    )
  })

  it('refuse a cursor sent with different filters', () => {
    const cursor = encodeListCursor('deck', { key: 'k', id: 'i' }, filter)
    expect(() => decodeListCursor('deck', cursor, { query: null, folderId: null })).toThrow(
      /filters differ/,
    )
  })
})

describe('deck.list', () => {
  it('returns lean items, most recently changed first, and pages to the end', async () => {
    const c = ctx()
    const first = (await runCommand(registry, c, 'deck.list', { limit: 1 })) as {
      decks: Array<Record<string, unknown>>
      nextCursor: string | null
    }
    expect(first.decks).toHaveLength(1)
    expect(Object.keys(first.decks[0]!).sort()).toEqual([
      'folderId',
      'id',
      'role',
      'title',
      'updatedAt',
    ])
    expect(first.nextCursor).not.toBeNull()
    const second = (await runCommand(registry, c, 'deck.list', {
      limit: 1,
      cursor: first.nextCursor,
    })) as { decks: Array<{ id: string }>; nextCursor: string | null }
    expect(second.decks).toHaveLength(1)
    expect(second.decks[0]!.id).not.toBe(first.decks[0]!['id'])
    expect(second.nextCursor).toBeNull()
  })

  it('passes filters, the default limit and the decoded keyset to the service', async () => {
    const c = ctx()
    await runCommand(registry, c, 'deck.list', { query: '  appendix ' })
    const [call] = c.services.calls.filter((x) => x.service === 'decks' && x.method === 'listPage')
    expect(call?.args).toMatchObject({ userId: 'u1', query: 'appendix', limit: 50 })
    const page = (await runCommand(registry, c, 'deck.list', { query: 'appendix' })) as {
      decks: Array<{ title: string }>
    }
    expect(page.decks.map((d) => d.title)).toEqual(['Appendix'])
  })

  it('refuses a limit over 200, a blank query and a cursor from another query', async () => {
    const c = ctx()
    expect((await failure(runCommand(registry, c, 'deck.list', { limit: 201 }))).code).toBe(
      'invalid_input',
    )
    expect((await failure(runCommand(registry, c, 'deck.list', { query: '   ' }))).code).toBe(
      'invalid_input',
    )
    const { nextCursor } = (await runCommand(registry, c, 'deck.list', { limit: 1 })) as {
      nextCursor: string
    }
    const e = await failure(
      runCommand(registry, c, 'deck.list', { limit: 1, cursor: nextCursor, query: 'fixture' }),
    )
    expect(e.code).toBe('invalid_input')
  })
})

describe('folder.list', () => {
  it('sorts by name and pages with a cursor', async () => {
    const c = ctx()
    const names: string[] = []
    let cursor: string | null = null
    do {
      const page = (await runCommand(registry, c, 'folder.list', {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      })) as { folders: Array<{ name: string; deckCount: number }>; nextCursor: string | null }
      names.push(...page.folders.map((f) => f.name))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(names).toEqual(['Client A', 'Client B', 'Drafts'])
  })

  it('filters by name', async () => {
    const page = (await runCommand(registry, ctx(), 'folder.list', { query: 'DRAFT' })) as {
      folders: Array<{ name: string }>
    }
    expect(page.folders.map((f) => f.name)).toEqual(['Drafts'])
  })
})
