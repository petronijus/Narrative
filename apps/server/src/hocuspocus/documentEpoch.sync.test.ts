/**
 * hocuspocus/documentEpoch.sync.test.ts — what an old local copy does to
 * the server's document, over a real WebSocket (ADR 0017).
 *
 * The browser keeps a copy of what the server confirmed and connects with it
 * already in its Y.Doc. Three cases, each driven through the real
 * `onAuthenticate` hook, the epoch extension and HocuspocusProvider:
 *
 *   1. The server EDITED the document after the copy was taken (a data
 *      migration, token propagation, an agent run: CRDT edits through the
 *      sync server): the copy merges back harmlessly — what the server
 *      removed stays removed, on the server and in the client.
 *   2. The server REPLACED the document (new state, new identities) and the
 *      epoch was NOT bumped: the copy's items come back — the hazard.
 *   3. The same replacement with the epoch bumped: the connection is refused
 *      with `stale-document` and the server's document stays as replaced.
 */

import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Server } from '@hocuspocus/server'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { getTableName, type Table } from 'drizzle-orm'
import {
  DOCUMENT_EPOCH_MESSAGE_TYPE,
  STALE_DOCUMENT_REASON,
  connectToken,
  parseDocumentEpochMessage,
} from '@narrative/shared'
import type { Database } from '../db/client.js'
import { createOnAuthenticate } from './authenticate.js'
import { documentEpochExtension } from './documentEpoch.js'

interface Current {
  docEpoch: number
  generation: number
  floor: number
}

/** The deck row both reads of `onAuthenticate` see: an editor's grant, and the epoch. */
function deckDb(current: () => Current): Database {
  const select = () => {
    let table = ''
    const rows = async (): Promise<unknown[]> =>
      table === 'decks' ? [{ deckRole: 'editor', folderRole: null, ...current() }] : []
    const chain = {
      from: (t: Table) => {
        table = getTableName(t)
        return chain
      },
      leftJoin: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: rows,
      then: (ok: (r: unknown[]) => unknown, err?: (e: unknown) => unknown) => rows().then(ok, err),
    }
    return chain
  }
  return { select } as unknown as Database
}

/** A deck-like document: slide ids in order. */
function slideIds(doc: Y.Doc): string[] {
  return doc
    .getArray<Y.Map<unknown>>('slides')
    .toArray()
    .map((s) => s.get('id') as string)
}

function addSlides(doc: Y.Doc, ids: string[]): void {
  doc.transact(() => {
    const slides = doc.getArray<Y.Map<unknown>>('slides')
    for (const id of ids) {
      const slide = new Y.Map<unknown>()
      slide.set('id', id)
      slides.push([slide])
    }
  })
}

/** Document epoch 1 at generation 100, nothing refused below generation 50. */
const AT_1: Current = { docEpoch: 1, generation: 100, floor: 50 }

let server: Server | null = null
const providers: HocuspocusProvider[] = []

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy()
  await server?.destroy()
  server = null
})

/** A sync server whose document `name` starts as `initial`, at the epoch `epoch()`. */
async function startServer(
  name: string,
  initial: Uint8Array,
  epoch: () => Current,
): Promise<Server> {
  server = new Server({
    port: 0,
    quiet: true,
    stopOnSignals: false,
    onAuthenticate: createOnAuthenticate({ db: deckDb(epoch), bypass: true }),
    extensions: [documentEpochExtension()],
    async onLoadDocument({ document, documentName }) {
      if (documentName === name) Y.applyUpdate(document, initial)
      return document
    },
  })
  await server.listen()
  return server
}

interface Outcome {
  synced: boolean
  refusal: string | null
  epochs: string[]
}

/** Connect `doc` (holding a local copy) claiming `claim`; resolves on sync or refusal. */
function connect(srv: Server, name: string, doc: Y.Doc, claim: string | null): Promise<Outcome> {
  return new Promise((resolve) => {
    const epochs: string[] = []
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.address.port}`,
      name,
      document: doc,
      token: connectToken(claim),
      onStateless: ({ payload }) => {
        const message = parseDocumentEpochMessage(payload)
        if (message !== null) epochs.push(message.epoch)
      },
      onSynced: ({ state }) => {
        if (!state) return
        // The client's own sync step 2 (what the server lacks) is acknowledged next.
        const check = (): void => {
          if (provider.hasUnsyncedChanges) return
          provider.off('unsyncedChanges', check)
          resolve({ synced: true, refusal: null, epochs })
        }
        provider.on('unsyncedChanges', check)
        check()
      },
      onAuthenticationFailed: ({ reason }) => resolve({ synced: false, refusal: reason, epochs }),
    })
    providers.push(provider)
  })
}

describe('a local copy meets the server document', () => {
  it('merges harmlessly after the server EDITED the document: removed content stays removed', async () => {
    const original = new Y.Doc()
    addSlides(original, ['a', 'b', 'c'])
    const initial = Y.encodeStateAsUpdate(original)
    const srv = await startServer('deck-edit', initial, () => AT_1)

    // The browser's copy, taken while the deck had a, b, c.
    const copy = new Y.Doc()
    Y.applyUpdate(copy, initial)

    // The server deletes b through the sync server, as a data migration does.
    // (The direct connection stays open: this server stores nothing, and an
    // unloaded document would come back from `initial`.)
    const direct = await srv.hocuspocus.openDirectConnection('deck-edit')
    await direct.transact((doc) => {
      doc.getArray('slides').delete(1, 1)
    })

    const outcome = await connect(srv, 'deck-edit', copy, '100.1')
    await direct.disconnect()
    expect(outcome).toMatchObject({ synced: true, refusal: null })
    expect(outcome.epochs).toEqual(['100.1'])
    expect(slideIds(srv.hocuspocus.documents.get('deck-edit')!)).toEqual(['a', 'c'])
    expect(slideIds(copy)).toEqual(['a', 'c'])
  })

  it('brings old content back after the server REPLACED the document without bumping the epoch', async () => {
    const original = new Y.Doc()
    addSlides(original, ['a', 'b'])
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(original))

    // Replaced: a new document (new identities) with one slide.
    const replaced = new Y.Doc()
    addSlides(replaced, ['fresh'])
    const srv = await startServer('deck-replaced', Y.encodeStateAsUpdate(replaced), () => AT_1)

    const outcome = await connect(srv, 'deck-replaced', copy, '100.1')
    expect(outcome.synced).toBe(true)
    // The hazard the epoch exists for: the copy's slides are on the server again.
    expect(slideIds(srv.hocuspocus.documents.get('deck-replaced')!).sort()).toEqual([
      'a',
      'b',
      'fresh',
    ])
  })

  it('refuses the copy when the replacement bumped the epoch, and the document stays replaced', async () => {
    const original = new Y.Doc()
    addSlides(original, ['a', 'b'])
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(original))

    const replaced = new Y.Doc()
    addSlides(replaced, ['fresh'])
    const srv = await startServer('deck-bumped', Y.encodeStateAsUpdate(replaced), () => ({
      ...AT_1,
      docEpoch: 2,
    }))

    const outcome = await connect(srv, 'deck-bumped', copy, '100.1')
    expect(outcome).toEqual({ synced: false, refusal: STALE_DOCUMENT_REASON, epochs: [] })

    // Nothing of the copy reached the server's document: a second, empty
    // client (what the browser opens after deleting its copy) sees the
    // replacement only, and is told the new epoch.
    const fresh = new Y.Doc()
    const second = await connect(srv, 'deck-bumped', fresh, null)
    expect(second).toEqual({ synced: true, refusal: null, epochs: ['100.2'] })
    expect(slideIds(fresh)).toEqual(['fresh'])
    expect(slideIds(srv.hocuspocus.documents.get('deck-bumped')!)).toEqual(['fresh'])
  })

  it('refuses a copy taken after the backup once the restored database raised its floor', async () => {
    // The backup holds slides a, b at generation 100. After it, the server
    // advanced to 160 (the backup's bump) and someone added c; a browser's
    // copy holds a, b, c stamped 160.1.
    const backup = new Y.Doc()
    addSlides(backup, ['a', 'b'])
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(backup))
    addSlides(copy, ['c'])

    // Restored: the backup's rows (docEpoch still 1), and the boot check saw
    // the marker (160) above the database's generation (100) and moved
    // generation and floor to 161.
    const srv = await startServer('deck-restored', Y.encodeStateAsUpdate(backup), () => ({
      docEpoch: 1,
      generation: 161,
      floor: 161,
    }))
    const outcome = await connect(srv, 'deck-restored', copy, '160.1')
    expect(outcome).toEqual({ synced: false, refusal: STALE_DOCUMENT_REASON, epochs: [] })
    const fresh = new Y.Doc()
    await connect(srv, 'deck-restored', fresh, null)
    expect(slideIds(srv.hocuspocus.documents.get('deck-restored')!)).toEqual(['a', 'b'])
  })

  it('sends the epoch message in the shared wire format', async () => {
    const srv = await startServer('deck-msg', Y.encodeStateAsUpdate(new Y.Doc()), () => ({
      ...AT_1,
      docEpoch: 4,
    }))
    const raw: string[] = []
    await new Promise<void>((resolve) => {
      const provider = new HocuspocusProvider({
        url: `ws://127.0.0.1:${srv.address.port}`,
        name: 'deck-msg',
        document: new Y.Doc(),
        token: connectToken(null),
        onStateless: ({ payload }) => {
          raw.push(payload)
          resolve()
        },
      })
      providers.push(provider)
    })
    expect(JSON.parse(raw[0]!)).toEqual({
      type: DOCUMENT_EPOCH_MESSAGE_TYPE,
      documentName: 'deck-msg',
      epoch: '100.4',
    })
  })
})
