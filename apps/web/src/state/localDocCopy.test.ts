/**
 * localDocCopy.test.ts — one document's local copy next to its provider
 * (ADR 0017): read before the provider exists and applied outside undo
 * history, written only in states the server confirmed, the epoch claim,
 * refusals (stale, revoked) and rebuilding, share links, a copy that fails to
 * decode, and the final flush.
 *
 * The provider is a stand-in with HocuspocusProvider's events and flags
 * (`synced`, `hasUnsyncedChanges`, 'open' / 'stateless' / 'synced' /
 * 'unsyncedChanges' / 'authenticationFailed'); the store is the real one on
 * fake-indexeddb. The wire protocol itself is covered on the server
 * (hocuspocus/documentEpoch.sync.test.ts).
 */

import { IDBFactory } from 'fake-indexeddb'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { DOCUMENT_EPOCH_MESSAGE_TYPE, STALE_DOCUMENT_REASON, connectToken } from '@narrative/shared'
import { LOCAL_ORIGIN } from '@narrative/slide-model'
import {
  LOCAL_COPY_DEBOUNCE_MS,
  LOCAL_COPY_ORIGIN,
  isNoCopyPage,
  localCopyUserFor,
  openDocumentCopy,
  setLocalCopyUser,
  type DocumentCopy,
} from './localDocCopy'
import {
  __resetLocalDocStoreForTests,
  hasLocalDoc,
  readLocalDoc,
  writeLocalDoc,
} from './localDocStore'

const USER = 'ann'
const NAME = 'deck-1'

class FakeProvider {
  synced = false
  unsynced = 0
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  get hasUnsyncedChanges(): boolean {
    return this.unsynced > 0
  }
  on(event: string, cb: (payload: unknown) => void): void {
    let set = this.listeners.get(event)
    if (set === undefined) this.listeners.set(event, (set = new Set()))
    set.add(cb)
  }
  off(event: string, cb: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(cb)
  }
  emit(event: string, payload?: unknown): void {
    for (const cb of [...(this.listeners.get(event) ?? [])]) cb(payload)
  }
  /** A connection opens and the server tells it the epoch. */
  connect(epoch: string): void {
    this.emit('open', {})
    this.emit('stateless', {
      payload: JSON.stringify({ type: DOCUMENT_EPOCH_MESSAGE_TYPE, documentName: NAME, epoch }),
    })
  }
  /** The server's sync step 2 arrives (with `remote` applied to `doc` first). */
  sync(doc: Y.Doc, remote?: (doc: Y.Doc) => void): void {
    if (remote !== undefined) doc.transact(() => remote(doc), this)
    this.synced = true
    this.emit('synced', { state: true })
  }
  /** A local update was sent / acknowledged. */
  sent(): void {
    this.unsynced++
    this.emit('unsyncedChanges', { number: this.unsynced })
  }
  acked(): void {
    this.unsynced = Math.max(0, this.unsynced - 1)
    this.emit('unsyncedChanges', { number: this.unsynced })
  }
  refuse(reason: string): void {
    this.emit('authenticationFailed', { reason })
  }
  detached = false
  detach(): void {
    this.detached = true
  }
  /** The server's sync step 1, carrying its state vector (as the provider's 'message' event). */
  serverStep1(serverDoc: Y.Doc): void {
    this.emit('message', { message: fakeMessage([0, 0], Y.encodeStateVector(serverDoc)) })
  }
  /** The server's answer to the client's sync step 2 (1 applied, 0 not). */
  syncStatus(applied: boolean): void {
    this.emit('message', { message: fakeMessage([8, applied ? 1 : 0]) })
  }
}

/** A received message as the provider's IncomingMessage reads it. */
function fakeMessage(uints: number[], bytes?: Uint8Array) {
  const queue = [...uints]
  return {
    readVarString: () => NAME,
    readVarUint: () => queue.shift() ?? 0,
    readVarUint8Array: () => bytes ?? new Uint8Array(),
  }
}

function slides(doc: Y.Doc): string[] {
  return doc.getArray<string>('slides').toArray()
}

/** A document of the server's, as an update. */
function serverState(ids: string[]): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc()
  doc.getArray<string>('slides').push(ids)
  return { doc, update: Y.encodeStateAsUpdate(doc) }
}

interface Opened {
  doc: Y.Doc
  copy: DocumentCopy
  provider: FakeProvider
  rebuilt: ReturnType<typeof vi.fn>
  started: ReturnType<typeof vi.fn>
}

function open(user: string | null = USER): Opened {
  const doc = new Y.Doc()
  const rebuilt = vi.fn()
  const copy = openDocumentCopy({ doc, documentName: NAME, user, onRebuild: rebuilt })
  const provider = new FakeProvider()
  const started = vi.fn(() => copy.attach(provider as unknown as HocuspocusProvider))
  copy.whenReady(started)
  return { doc, copy, provider, rebuilt, started }
}

/** Let IndexedDB and pending promises run (fake-indexeddb schedules with setImmediate). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

/** Past the debounce, then the idle callback (a setTimeout in jsdom), then the store. */
async function flushWrites(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LOCAL_COPY_DEBOUNCE_MS + 10)
  await vi.advanceTimersByTimeAsync(10)
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('indexedDB', new IDBFactory())
  // jsdom has no requestIdleCallback: the session falls back to a timer.
  vi.stubGlobal('requestIdleCallback', undefined)
  localStorage.clear()
  __resetLocalDocStoreForTests()
  setLocalCopyUser(USER)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  __resetLocalDocStoreForTests()
})

describe('a document without a stored copy', () => {
  it('starts its provider synchronously and claims nothing', () => {
    const { started, copy } = open()
    expect(started).toHaveBeenCalledTimes(1)
    expect(copy.token()).toBe(connectToken(null))
  })

  it('writes a base once the server confirmed the synced state, then increments', async () => {
    const { doc, provider, copy } = open()
    provider.connect('100.1')
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['a', 'b']))
    await flushWrites()
    expect(hasLocalDoc(USER, NAME)).toBe(true)
    expect(copy.token()).toBe(connectToken('100.1'))

    // A local edit: written once acknowledged, as an increment.
    doc.transact(() => doc.getArray<string>('slides').push(['c']), LOCAL_ORIGIN)
    provider.sent()
    await flushWrites()
    expect((await readLocalDoc(USER, NAME))?.updates).toHaveLength(1)
    provider.acked()
    await flushWrites()
    const read = await readLocalDoc(USER, NAME)
    expect(read?.updates).toHaveLength(2)
    const restored = new Y.Doc()
    for (const u of read!.updates) Y.applyUpdate(restored, u)
    expect(slides(restored)).toEqual(['a', 'b', 'c'])
  })

  it('never writes before the connection was told its epoch (an older server)', async () => {
    const { doc, provider } = open()
    provider.emit('open', {})
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['a']))
    await flushWrites()
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it("never stores a read-only connection's rejected writes", async () => {
    const { doc, provider, copy } = open()
    provider.connect('100.1')
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['server']))
    await flushWrites()
    // A viewer's local write: the server answers "not applied", so it is never acknowledged.
    doc.transact(() => doc.getArray<string>('slides').push(['ghost']), LOCAL_ORIGIN)
    provider.sent()
    await flushWrites()
    copy.close()
    await settle()
    const restored = new Y.Doc()
    for (const u of (await readLocalDoc(USER, NAME))!.updates) Y.applyUpdate(restored, u)
    expect(slides(restored)).toEqual(['server'])
  })

  it('keeps no copy for a share-link visit or a signed-out page, but still claims its epoch', async () => {
    setLocalCopyUser(USER)
    expect(localCopyUserFor('?share_token=abc')).toBeNull()
    expect(localCopyUserFor('')).toBe(USER)
    setLocalCopyUser(null)
    expect(localCopyUserFor('')).toBeNull()

    const { doc, provider, copy } = open(null)
    provider.connect('100.3')
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['a']))
    await flushWrites()
    expect(hasLocalDoc(USER, NAME)).toBe(false)
    // A reconnect claims the epoch of what the document holds.
    expect(copy.token()).toBe(connectToken('100.3'))
  })

  it('writes the confirmed state when it closes', async () => {
    const { doc, provider, copy } = open()
    provider.connect('100.1')
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['a']))
    copy.close()
    await settle()
    expect(hasLocalDoc(USER, NAME)).toBe(true)
  })
})

describe('a document with a stored copy', () => {
  async function stored(ids: string[], epoch = '100.1'): Promise<Y.Doc> {
    const { doc, update } = serverState(ids)
    await writeLocalDoc({ user: USER, documentName: NAME, epoch, base: update })
    return doc
  }

  it('applies the copy before the provider exists, outside undo history, and claims its epoch', async () => {
    await stored(['a', 'b'], '100.4')
    const doc = new Y.Doc()
    // (Creating a root type runs an empty transaction of Yjs's own: before the probe.)
    const undo = new Y.UndoManager(doc.getArray('slides'), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    })
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const copy = openDocumentCopy({ doc, documentName: NAME, user: USER, onRebuild: vi.fn() })
    const started = vi.fn(() => {
      // The copy is in when the provider is created.
      expect(slides(doc)).toEqual(['a', 'b'])
    })
    copy.whenReady(started)
    expect(started).not.toHaveBeenCalled()
    await settle()
    expect(started).toHaveBeenCalledTimes(1)
    expect(origins).toEqual([LOCAL_COPY_ORIGIN])
    expect(undo.undoStack).toHaveLength(0)
    expect(copy.token()).toBe(connectToken('100.4'))
    expect(copy.showsUnconfirmedCopy).toBe(true)
  })

  it('appends what the sync brought as an increment on top of the stored copy', async () => {
    const server = await stored(['a'])
    const { doc, provider } = open()
    await settle()
    provider.connect('100.1')
    provider.sync(doc, (d) => {
      server.getArray<string>('slides').push(['b'])
      Y.applyUpdate(d, Y.encodeStateAsUpdate(server))
    })
    await flushWrites()
    const read = await readLocalDoc(USER, NAME)
    expect(read?.updates).toHaveLength(2)
    const restored = new Y.Doc()
    for (const u of read!.updates) Y.applyUpdate(restored, u)
    expect(slides(restored)).toEqual(['a', 'b'])
  })

  it('rebuilds and deletes the copy on a stale epoch', async () => {
    await stored(['old'], '100.1')
    const { provider, rebuilt, copy } = open()
    await settle()
    expect(copy.rebuildsOn(STALE_DOCUMENT_REASON)).toBe(true)
    provider.refuse(STALE_DOCUMENT_REASON)
    await settle()
    expect(rebuilt).toHaveBeenCalledTimes(1)
    expect(copy.closed).toBe(true)
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('stops showing a copy the server refused before its first sync (a revoked deck)', async () => {
    await stored(['secret'])
    const { provider, rebuilt } = open()
    await settle()
    provider.refuse('permission-denied')
    await settle()
    expect(rebuilt).toHaveBeenCalledTimes(1)
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('deletes the copy but keeps the document when access ends after the sync', async () => {
    await stored(['a'])
    const { doc, provider, rebuilt, copy } = open()
    await settle()
    provider.connect('100.1')
    provider.sync(doc)
    expect(copy.rebuildsOn('permission-denied')).toBe(false)
    provider.refuse('permission-denied')
    await settle()
    expect(rebuilt).not.toHaveBeenCalled()
    expect(hasLocalDoc(USER, NAME)).toBe(false)
    // And writes nothing more.
    doc.transact(() => doc.getArray<string>('slides').push(['b']), provider)
    await flushWrites()
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('throws away a copy that does not decode', async () => {
    await writeLocalDoc({
      user: USER,
      documentName: NAME,
      epoch: '100.1',
      base: new Uint8Array([1, 2, 3, 4, 5, 250, 251]),
    })
    const { rebuilt, started } = open()
    await settle()
    expect(rebuilt).toHaveBeenCalledTimes(1)
    expect(started).not.toHaveBeenCalled()
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('confirms an unchanged copy instead of rewriting it', async () => {
    await stored(['a'])
    const before = (await readLocalDoc(USER, NAME))!.confirmedAt
    const { doc, provider } = open()
    await settle()
    vi.setSystemTime(Date.now() + 60_000)
    provider.connect('100.1')
    provider.sync(doc)
    await flushWrites()
    const read = await readLocalDoc(USER, NAME)
    expect(read?.updates).toHaveLength(1)
    expect(read!.confirmedAt).toBeGreaterThan(before)
  })
})

describe('security review (M2, M3, L2)', () => {
  async function storedCopy(ids: string[]): Promise<Y.Doc> {
    const { doc, update } = serverState(ids)
    await writeLocalDoc({ user: USER, documentName: NAME, epoch: '100.1', base: update })
    return doc
  }

  it('confirms an unchanged copy only once the server acknowledged the answer to its sync', async () => {
    await storedCopy(['a'])
    const before = (await readLocalDoc(USER, NAME))!.confirmedAt
    const { doc, provider } = open()
    await settle()
    vi.setSystemTime(Date.now() + 60_000)
    provider.connect('100.1')
    // startSync counts the client's answer as unsynced until the server acks it.
    provider.unsynced = 1
    provider.sync(doc)
    await flushWrites()
    expect((await readLocalDoc(USER, NAME))!.confirmedAt).toBe(before)
    provider.acked()
    await flushWrites()
    expect((await readLocalDoc(USER, NAME))!.confirmedAt).toBeGreaterThan(before)
  })

  it('drops a copy holding items the server lacks, before the provider can answer with them', async () => {
    await storedCopy(['planted'])
    const { provider, rebuilt } = open()
    await settle()
    provider.connect('100.1')
    // The server's state does not have the copy's items.
    provider.serverStep1(new Y.Doc())
    await settle()
    expect(provider.detached).toBe(true)
    expect(rebuilt).toHaveBeenCalledTimes(1)
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('keeps a copy the server holds all of', async () => {
    const server = await storedCopy(['a', 'b'])
    server.getArray<string>('slides').push(['newer'])
    const { provider, rebuilt } = open()
    await settle()
    provider.connect('100.1')
    provider.serverStep1(server)
    provider.syncStatus(true)
    expect(provider.detached).toBe(false)
    expect(rebuilt).not.toHaveBeenCalled()
  })

  it('drops a copy a read-only connection did not apply, when the session sent nothing of its own', async () => {
    const server = await storedCopy(['a'])
    const { provider, rebuilt } = open()
    await settle()
    provider.connect('100.1')
    provider.serverStep1(server)
    provider.syncStatus(false)
    await settle()
    expect(rebuilt).toHaveBeenCalledTimes(1)
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it("does not take a viewer's own rejected writes for a foreign copy", async () => {
    const server = await storedCopy(['a'])
    const { doc, provider, rebuilt } = open()
    await settle()
    provider.connect('100.1')
    provider.serverStep1(server)
    doc.transact(() => doc.getArray<string>('slides').push(['mine']), LOCAL_ORIGIN)
    provider.syncStatus(false)
    expect(rebuilt).not.toHaveBeenCalled()
  })

  it('stops writing for a user who is not signed in any more', async () => {
    const { doc, provider, copy } = open()
    provider.connect('100.1')
    provider.sync(doc, (d) => d.getArray<string>('slides').push(['a']))
    setLocalCopyUser('someone-else')
    await flushWrites()
    copy.close()
    await settle()
    setLocalCopyUser(USER)
    expect(hasLocalDoc(USER, NAME)).toBe(false)
  })

  it('shows nothing of a copy read for a user who signed out meanwhile', async () => {
    await storedCopy(['a'])
    const { doc } = open()
    setLocalCopyUser(null)
    await settle()
    expect(slides(doc)).toEqual([])
  })

  it('keeps no copy on the render pages', () => {
    for (const path of ['/deck/abc/render', '/folder/f/component/c/render', '/deck/abc/render/']) {
      expect(isNoCopyPage(path)).toBe(true)
      expect(localCopyUserFor('', path)).toBeNull()
    }
    for (const path of ['/deck/abc', '/deck/abc/present', '/folder/f/component/c']) {
      expect(isNoCopyPage(path)).toBe(false)
      expect(localCopyUserFor('', path)).toBe(USER)
    }
  })
})

describe('the stored copy never holds what the server lacks (property)', () => {
  const step = fc.oneof(
    fc.record({ kind: fc.constant('server' as const), value: fc.string({ maxLength: 3 }) }),
    fc.record({ kind: fc.constant('serverDelete' as const) }),
    fc.record({ kind: fc.constant('client' as const), value: fc.string({ maxLength: 3 }) }),
    fc.record({ kind: fc.constant('clientDelete' as const) }),
    fc.record({ kind: fc.constant('deliver' as const) }),
    fc.record({ kind: fc.constant('tick' as const) }),
  )

  it('for any interleaving of edits, acknowledgements and writes, read-write or read-only', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 30 }), fc.boolean(), async (steps, readOnly) => {
        localStorage.clear()
        vi.stubGlobal('indexedDB', new IDBFactory())
        __resetLocalDocStoreForTests()
        setLocalCopyUser(USER)

        const server = new Y.Doc()
        server.getArray<string>('slides').push(['seed'])
        const { doc, provider, copy } = open()
        const queued: Uint8Array[] = []
        doc.on('update', (u: Uint8Array, origin: unknown) => {
          if (origin === LOCAL_ORIGIN) queued.push(u)
        })
        const fromServer = (): void => {
          Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(doc)), provider)
        }
        provider.connect('100.1')
        provider.sync(doc, () => fromServer())

        const deliver = (): void => {
          const u = queued.shift()
          if (u === undefined) return
          // A read-only connection's update is answered "not applied": never acknowledged.
          if (readOnly) return
          Y.applyUpdate(server, u)
          provider.acked()
        }
        for (const s of steps) {
          const slides = (d: Y.Doc) => d.getArray<string>('slides')
          if (s.kind === 'server') {
            slides(server).push([s.value])
            fromServer()
          } else if (s.kind === 'serverDelete' && slides(server).length > 0) {
            slides(server).delete(0, 1)
            fromServer()
          } else if (s.kind === 'client') {
            doc.transact(() => slides(doc).push([s.value]), LOCAL_ORIGIN)
            provider.sent()
          } else if (s.kind === 'clientDelete' && slides(doc).length > 0) {
            doc.transact(() => slides(doc).delete(0, 1), LOCAL_ORIGIN)
            provider.sent()
          } else if (s.kind === 'deliver') {
            deliver()
          } else if (s.kind === 'tick') {
            await flushWrites()
          }
        }
        while (queued.length > 0) deliver()
        await flushWrites()
        copy.close()
        await settle()

        const read = await readLocalDoc(USER, NAME)
        if (read === null) return
        const restored = new Y.Doc()
        for (const u of read.updates) Y.applyUpdate(restored, u)
        const merged = Y.encodeStateAsUpdate(restored)
        expect(Y.snapshotContainsUpdate(Y.snapshot(server), merged)).toBe(true)
        if (!readOnly) {
          // Everything was acknowledged: the copy is the document.
          expect(restored.getArray('slides').toArray()).toEqual(server.getArray('slides').toArray())
        }
      }),
      { numRuns: 60 },
    )
  })
})
