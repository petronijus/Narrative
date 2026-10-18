/**
 * agent/folderReads.test.ts — the per-command folder lookup and the per-run
 * cache of folder documents: kept while the version is unchanged, read
 * again when it changes or cannot be told, never handed out to be changed.
 * The host-level behaviour (sessions, live edits, a deck moving) is in
 * serverHost.test.ts → folder tokens.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createFolderReadScope,
  FolderDocumentCache,
  liveDocumentVersion,
  readFolderDerived,
  type FolderDocumentSources,
} from './folderReads.js'

function sources(opts: { versioned?: boolean } = {}) {
  const state = { version: 'v1', reads: 0, lookups: 0, value: 'red' }
  const src: FolderDocumentSources = {
    folderOf: async () => {
      state.lookups += 1
      return 'f1'
    },
    readFolder: async () => {
      state.reads += 1
      const doc = new Y.Doc()
      doc.getMap('tokens').set('ink', state.value)
      return doc
    },
    ...(opts.versioned === false ? {} : { version: async () => state.version }),
  }
  return { state, src }
}

const ink = (doc: Y.Doc) => ({ ink: doc.getMap('tokens').get('ink') as string })

describe('readFolderDerived', () => {
  it('reads the document once while its version stays the same', async () => {
    const { state, src } = sources()
    const cache = new FolderDocumentCache()
    for (let i = 0; i < 3; i++) {
      const scope = createFolderReadScope(cache)
      expect(await readFolderDerived(src, 'f1', 'tokens', scope, ink)).toEqual({ ink: 'red' })
    }
    expect(state.reads).toBe(1)
  })

  it('reads it again once the version changes', async () => {
    const { state, src } = sources()
    const cache = new FolderDocumentCache()
    await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    state.version = 'v2'
    state.value = 'blue'
    expect(await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)).toEqual(
      { ink: 'blue' },
    )
    expect(state.reads).toBe(2)
  })

  it('keeps each kind apart, derived from the same version', async () => {
    const { state, src } = sources()
    const cache = new FolderDocumentCache()
    const scope = createFolderReadScope(cache)
    await readFolderDerived(src, 'f1', 'tokens', scope, ink)
    expect(await readFolderDerived(src, 'f1', 'stylePack', scope, () => 'pack')).toBe('pack')
    expect(await readFolderDerived(src, 'f1', 'stylePack', scope, () => 'other')).toBe('pack')
    expect(state.reads).toBe(2)
  })

  it('reads every time without a run, or when the source cannot tell a version', async () => {
    const { state, src } = sources()
    await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(null), ink)
    await readFolderDerived(src, 'f1', 'tokens', undefined, ink)
    expect(state.reads).toBe(2)

    const unversioned = sources({ versioned: false })
    const cache = new FolderDocumentCache()
    await readFolderDerived(unversioned.src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    await readFolderDerived(unversioned.src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    expect(unversioned.state.reads).toBe(2)
  })

  it('hands out copies: a command changing what it got changes nothing kept', async () => {
    const { src } = sources()
    const cache = new FolderDocumentCache()
    const first = await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    first.ink = 'changed by a handler'
    const second = await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    expect(second).toEqual({ ink: 'red' })
    second.ink = 'changed again'
    const third = await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)
    expect(third).toEqual({ ink: 'red' })
  })

  it('takes the version before the read: a change racing the read is read again next time', async () => {
    const { state, src } = sources()
    const racing: FolderDocumentSources = {
      ...src,
      readFolder: async (id) => {
        // The document changes after its version was taken, before it is read.
        state.version = 'v2'
        state.value = 'blue'
        return src.readFolder(id)
      },
    }
    const cache = new FolderDocumentCache()
    expect(
      await readFolderDerived(racing, 'f1', 'tokens', createFolderReadScope(cache), ink),
    ).toEqual({ ink: 'blue' })
    // Kept under v1, which no longer matches: read again, not served stale.
    state.value = 'green'
    expect(await readFolderDerived(src, 'f1', 'tokens', createFolderReadScope(cache), ink)).toEqual(
      { ink: 'green' },
    )
    expect(state.reads).toBe(2)
  })
})

describe('createFolderReadScope', () => {
  it("looks the target's folder up once per command", async () => {
    const { state, src } = sources()
    const scope = createFolderReadScope(null)
    const lookup = (t: object) => src.folderOf(t)
    await Promise.all([scope.folderOf({}, lookup), scope.folderOf({}, lookup)])
    expect(state.lookups).toBe(1)
    await createFolderReadScope(null).folderOf({}, lookup)
    expect(state.lookups).toBe(2)
  })
})

describe('liveDocumentVersion', () => {
  it('changes with every update and differs between documents', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const first = liveDocumentVersion(a)
    expect(liveDocumentVersion(a)).toBe(first)
    a.getMap('tokens').set('ink', 'red')
    const second = liveDocumentVersion(a)
    expect(second).not.toBe(first)
    expect(liveDocumentVersion(b)).not.toBe(first)
    expect(liveDocumentVersion(b)).not.toBe(second)
  })
})
