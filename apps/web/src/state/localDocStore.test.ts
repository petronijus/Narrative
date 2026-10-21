/**
 * localDocStore.test.ts — the IndexedDB store of local document copies
 * (ADR 0017), against fake-indexeddb: bases and tails, per-user keys, the
 * synchronous index, sign-out and other users' copies, the age limit, the
 * caps, a full disk, and a browser without IndexedDB.
 */

import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOCAL_DOC_MAX_AGE_MS,
  LOCAL_DOC_MAX_DOCUMENTS,
  MAX_TAILS,
  __listLocalDocsForTests,
  __resetLocalDocStoreForTests,
  clearLocalDocs,
  confirmLocalDoc,
  LOCAL_DOC_MAX_BYTES,
  deleteLocalDoc,
  hasLocalDoc,
  indexedLocalDocs,
  localDocsDisabledOnDevice,
  pruneLocalDocs,
  readLocalDoc,
  retainOnlyLocalDocsOf,
  setLocalDocStoreUser,
  setLocalDocsDisabledOnDevice,
  writeLocalDoc,
} from './localDocStore'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  localStorage.clear()
  __resetLocalDocStoreForTests()
  setLocalDocStoreUser('ann')
})

afterEach(() => {
  __resetLocalDocStoreForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local document store', () => {
  it('stores a base, then tails on top of it, read back in order', async () => {
    expect(hasLocalDoc('ann', 'deck-1')).toBe(false)
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'deck-1', epoch: '100.1', base: bytes(1) }),
    ).toBe('written')
    expect(hasLocalDoc('ann', 'deck-1')).toBe(true)
    await writeLocalDoc({ user: 'ann', documentName: 'deck-1', epoch: '100.1', tail: bytes(2) })
    await writeLocalDoc({ user: 'ann', documentName: 'deck-1', epoch: '100.1', tail: bytes(3) })
    const read = await readLocalDoc('ann', 'deck-1')
    expect(read?.epoch).toBe('100.1')
    expect(read?.updates.map((u) => [...u])).toEqual([[1], [2], [3]])
  })

  it('replaces every tail with a new base', async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', tail: bytes(2) })
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(9) })
    expect((await readLocalDoc('ann', 'd'))?.updates.map((u) => [...u])).toEqual([[9]])
  })

  it('asks for a base when a tail has nothing of its epoch to go on', async () => {
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', tail: bytes(2) }),
    ).toBe('needs-base')
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.2', tail: bytes(2) }),
    ).toBe('needs-base')
    expect((await readLocalDoc('ann', 'd'))?.updates).toHaveLength(1)
  })

  it(`asks for a base once ${MAX_TAILS} tails piled up`, async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(0) })
    const results = []
    for (let i = 0; i < MAX_TAILS; i++) {
      results.push(
        await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', tail: bytes(i) }),
      )
    }
    expect(results.slice(0, -1).every((r) => r === 'written')).toBe(true)
    expect(results.at(-1)).toBe('needs-base')
  })

  it("never reads another user's copy", async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    expect(hasLocalDoc('bob', 'd')).toBe(false)
    expect(await readLocalDoc('bob', 'd')).toBeNull()
  })

  it("deletes other users' copies for the signed-in one, and everything on sign-out", async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'a', epoch: '100.1', base: bytes(1) })
    setLocalDocStoreUser('bob')
    await writeLocalDoc({ user: 'bob', documentName: 'b', epoch: '100.1', base: bytes(2) })
    await retainOnlyLocalDocsOf('bob')
    expect(hasLocalDoc('ann', 'a')).toBe(false)
    expect((await __listLocalDocsForTests()).map((m) => m.user)).toEqual(['bob'])
    expect(await readLocalDoc('bob', 'b')).not.toBeNull()

    await clearLocalDocs()
    expect(hasLocalDoc('bob', 'b')).toBe(false)
    expect(await __listLocalDocsForTests()).toEqual([])
  })

  it('deletes one copy', async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', tail: bytes(2) })
    await deleteLocalDoc('ann', 'd')
    expect(hasLocalDoc('ann', 'd')).toBe(false)
    expect(await readLocalDoc('ann', 'd')).toBeNull()
    expect(await __listLocalDocsForTests()).toEqual([])
  })

  it('drops a copy the server has not confirmed for 30 days, unless it confirms it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await writeLocalDoc({ user: 'ann', documentName: 'kept', epoch: '100.1', base: bytes(1) })
    await writeLocalDoc({ user: 'ann', documentName: 'old', epoch: '100.1', base: bytes(1) })
    vi.setSystemTime(Date.now() + LOCAL_DOC_MAX_AGE_MS - 1000)
    await confirmLocalDoc('ann', 'kept')
    vi.setSystemTime(Date.now() + 2000)
    expect(await readLocalDoc('ann', 'old')).toBeNull()
    expect(hasLocalDoc('ann', 'old')).toBe(false)
    expect(await readLocalDoc('ann', 'kept')).not.toBeNull()
  })

  it(`keeps at most ${LOCAL_DOC_MAX_DOCUMENTS} copies per user, the least recently opened go first`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let now = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 0; i <= LOCAL_DOC_MAX_DOCUMENTS; i++) {
      vi.setSystemTime((now += 1000))
      await writeLocalDoc({ user: 'ann', documentName: `d${i}`, epoch: '100.1', base: bytes(i) })
      // The first copy is opened again after each write: it stays the newest-but-one.
      if (i > 0 && i < LOCAL_DOC_MAX_DOCUMENTS) {
        vi.setSystemTime((now += 1))
        await readLocalDoc('ann', 'd0')
      }
    }
    const names = (await __listLocalDocsForTests()).map((m) => m.documentName)
    expect(names).toHaveLength(LOCAL_DOC_MAX_DOCUMENTS)
    expect(names).toContain('d0')
    expect(names).not.toContain('d1')
    expect(hasLocalDoc('ann', 'd1')).toBe(false)
  })

  it('evicts the older half of the other copies when the disk is full, then writes', async () => {
    for (let i = 0; i < 4; i++) {
      await writeLocalDoc({ user: 'ann', documentName: `d${i}`, epoch: '100.1', base: bytes(i) })
    }
    const put = IDBObjectStore.prototype.put
    let failures = 1
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'bases' && failures-- > 0) {
        throw new DOMException('full', 'QuotaExceededError')
      }
      return put.apply(this, args)
    })
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'new', epoch: '100.1', base: bytes(7) }),
    ).toBe('written')
    spy.mockRestore()
    const names = (await __listLocalDocsForTests()).map((m) => m.documentName).sort()
    expect(names).toContain('new')
    expect(names.length).toBeLessThan(5)
  })

  it('turns itself off when the disk stays full', async () => {
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
    spy.mockRestore()
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
    expect(hasLocalDoc('ann', 'd')).toBe(false)
  })

  it('forgets an index entry whose copy the browser evicted', async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    __resetLocalDocStoreForTests()
    setLocalDocStoreUser('ann')
    vi.stubGlobal('indexedDB', new IDBFactory())
    expect(hasLocalDoc('ann', 'd')).toBe(true)
    expect(await readLocalDoc('ann', 'd')).toBeNull()
    expect(hasLocalDoc('ann', 'd')).toBe(false)
  })

  it('is off, quietly, without IndexedDB or when opening it throws', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
    expect(await readLocalDoc('ann', 'd')).toBeNull()
    expect(hasLocalDoc('ann', 'd')).toBe(false)
    await expect(clearLocalDocs()).resolves.toBeUndefined()

    __resetLocalDocStoreForTests()
    setLocalDocStoreUser('ann')
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('private mode', 'InvalidStateError')
      },
    })
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
  })

  it('writes only for the signed-in user, and drops a write begun before a change of user', async () => {
    expect(
      await writeLocalDoc({ user: 'bob', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
    // A write that waits for the database while the user signs out.
    const pending = writeLocalDoc({
      user: 'ann',
      documentName: 'late',
      epoch: '100.1',
      base: bytes(1),
    })
    setLocalDocStoreUser(null)
    await clearLocalDocs()
    expect(await pending).toBe('off')
    expect(await __listLocalDocsForTests()).toEqual([])
    expect(hasLocalDoc('ann', 'late')).toBe(false)
    await confirmLocalDoc('ann', 'late')
    expect(await __listLocalDocsForTests()).toEqual([])
  })

  it('keeps one copy under the byte cap: a tail past it asks for a base, a bigger base is not kept', async () => {
    const big = new Uint8Array(LOCAL_DOC_MAX_BYTES - 10)
    expect(await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: big })).toBe(
      'written',
    )
    expect(
      await writeLocalDoc({
        user: 'ann',
        documentName: 'd',
        epoch: '100.1',
        tail: new Uint8Array(64),
      }),
    ).toBe('needs-base')
    expect((await readLocalDoc('ann', 'd'))?.updates).toHaveLength(1)
    expect(
      await writeLocalDoc({
        user: 'ann',
        documentName: 'd',
        epoch: '100.1',
        base: new Uint8Array(LOCAL_DOC_MAX_BYTES + 1),
      }),
    ).toBe('off')
    expect(hasLocalDoc('ann', 'd')).toBe(false)
  })

  it('evicts other copies once tails take the user past the byte cap', async () => {
    const half = Math.floor(LOCAL_DOC_MAX_BYTES / 2)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await writeLocalDoc({
      user: 'ann',
      documentName: 'old',
      epoch: '100.1',
      base: new Uint8Array(half),
    })
    vi.setSystemTime(Date.now() + 1000)
    await writeLocalDoc({
      user: 'ann',
      documentName: 'new',
      epoch: '100.1',
      base: new Uint8Array(half - 100),
    })
    expect(indexedLocalDocs('ann').sort()).toEqual(['new', 'old'])
    vi.setSystemTime(Date.now() + 1000)
    await writeLocalDoc({
      user: 'ann',
      documentName: 'new',
      epoch: '100.1',
      tail: new Uint8Array(200),
    })
    expect(indexedLocalDocs('ann')).toEqual(['new'])
  })

  it('keeps no copies on a device where they are turned off, and deletes those it had', async () => {
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    await setLocalDocsDisabledOnDevice(true)
    expect(localDocsDisabledOnDevice()).toBe(true)
    expect(hasLocalDoc('ann', 'd')).toBe(false)
    expect(await __listLocalDocsForTests()).toEqual([])
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('off')
    await setLocalDocsDisabledOnDevice(false)
    expect(
      await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) }),
    ).toBe('written')
  })

  it('prunes the copies a predicate says are gone', async () => {
    for (const name of ['deck-a', 'deck-b', 'folder:f1']) {
      await writeLocalDoc({ user: 'ann', documentName: name, epoch: '100.1', base: bytes(1) })
    }
    expect(await pruneLocalDocs('ann', (n) => n !== 'deck-a')).toEqual(['deck-b', 'folder:f1'])
    expect(indexedLocalDocs('ann')).toEqual(['deck-a'])
  })

  it('reads no copy of an earlier format', async () => {
    localStorage.setItem('narrative:local-docs:v1:ann', JSON.stringify(['deck-x']))
    await writeLocalDoc({ user: 'ann', documentName: 'd', epoch: '100.1', base: bytes(1) })
    await retainOnlyLocalDocsOf('ann')
    expect(localStorage.getItem('narrative:local-docs:v1:ann')).toBeNull()
  })
})
