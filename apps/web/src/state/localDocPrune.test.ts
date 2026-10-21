/**
 * localDocPrune.test.ts — copies of folders, masters and decks the user no
 * longer reaches are deleted when the home page has their folders (ADR 0017,
 * security review L1); errors that are not refusals keep them.
 */

import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client'
import { setLocalCopyUser } from './localDocCopy'
import { __resetLocalDocStoreForTests, indexedLocalDocs, writeLocalDoc } from './localDocStore'
import { pruneLocalCopies } from './localDocPrune'

const USER = 'ann'

async function keep(name: string): Promise<void> {
  await writeLocalDoc({ user: USER, documentName: name, epoch: '100.1', base: new Uint8Array([1]) })
}

function api(opts: {
  decks: Record<string, number>
  components: Record<string, string[]>
  failComponents?: boolean
}) {
  return {
    getDeck: vi.fn(async (id: string) => {
      const status = opts.decks[id] ?? 200
      if (status !== 200) throw new Error(`HTTP ${status}`)
      return { id } as never
    }),
    listComponents: vi.fn(async (folderId: string) => {
      if (opts.failComponents === true) throw new Error('HTTP 500')
      return (opts.components[folderId] ?? []).map((id) => ({ id })) as never
    }),
  } satisfies Pick<ApiClient, 'getDeck' | 'listComponents'>
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  __resetLocalDocStoreForTests()
  setLocalCopyUser(USER)
})

afterEach(() => {
  setLocalCopyUser(null)
  vi.unstubAllGlobals()
  __resetLocalDocStoreForTests()
})

describe('pruneLocalCopies', () => {
  it('deletes what the user no longer reaches, keeps the rest and what an error leaves unknown', async () => {
    for (const name of [
      'folder:f1',
      'folder:gone',
      'component:c1',
      'component:c-gone',
      'deck-ok',
      'deck-revoked',
      'deck-deleted',
      'deck-offline',
    ]) {
      await keep(name)
    }
    const client = api({
      decks: { 'deck-revoked': 403, 'deck-deleted': 404, 'deck-offline': 503 },
      components: { f1: ['c1'] },
    })
    const deleted = await pruneLocalCopies(client, [{ id: 'f1' }])
    expect(deleted.sort()).toEqual([
      'component:c-gone',
      'deck-deleted',
      'deck-revoked',
      'folder:gone',
    ])
    expect(indexedLocalDocs(USER).sort()).toEqual([
      'component:c1',
      'deck-offline',
      'deck-ok',
      'folder:f1',
    ])
  })

  it('keeps every component copy when a folder list fails', async () => {
    await keep('component:c-unknown')
    const deleted = await pruneLocalCopies(
      api({ decks: {}, components: {}, failComponents: true }),
      [{ id: 'f1' }],
    )
    expect(deleted).toEqual([])
  })

  it('does nothing when nobody is signed in', async () => {
    await keep('deck-revoked')
    setLocalCopyUser(null)
    const client = api({ decks: { 'deck-revoked': 403 }, components: {} })
    expect(await pruneLocalCopies(client, [])).toEqual([])
    expect(client.getDeck).not.toHaveBeenCalled()
  })
})
