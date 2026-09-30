/**
 * services/dataMigrations.test.ts — one-time document migrations run once:
 * a completed one is recorded and skipped afterwards, a failed one is not
 * recorded (so the next start retries it). And the A2.12 folder-token
 * migration: every folder seeded or brought up to date, linked text that
 * lags its style re-styled — through the sync server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import {
  addFolderToken,
  addObjects,
  createSlideDoc,
  getSlideObjectsCtx,
  listSlides,
  readFolderTokens,
} from '@narrative/slide-model'
import type { FastifyBaseLogger } from 'fastify'
import type { TextObject } from '@narrative/shared'
import { MemoryPersistence, quietLog } from '../test-support/agentWorld.js'
import { scriptedDb } from '../test-support/scriptedDb.js'
import {
  MAX_ATTEMPTS,
  folderTokensOnServer,
  runDataMigrations,
  type DataMigration,
} from './dataMigrations.js'

let hp: Hocuspocus
let persistence: MemoryPersistence
let open: Array<{ disconnect: () => Promise<void> }>

beforeEach(() => {
  persistence = new MemoryPersistence()
  hp = new Hocuspocus({ quiet: true, stopOnSignals: false, extensions: [persistence] })
  open = []
})

afterEach(async () => {
  for (const c of open) await c.disconnect()
  await hp.destroy?.()
})

async function openDoc(name: string): Promise<Y.Doc> {
  open.push(await hp.openDirectConnection(name))
  return hp.documents.get(name)!
}

function migration(id: string, run: DataMigration['run']): DataMigration {
  return { id, description: id, run: vi.fn(run) }
}

describe('runDataMigrations', () => {
  const deps = (db: ReturnType<typeof scriptedDb>, log: FastifyBaseLogger = quietLog) => ({
    db: db.db,
    log,
    hocuspocus: () => hp,
  })

  it('counts the try, runs a pending migration and records its report', async () => {
    const db = scriptedDb({ selects: [[]] })
    const m = migration('m1', async () => ({ touched: 3 }))
    await runDataMigrations(deps(db), [m])
    expect(m.run).toHaveBeenCalledOnce()
    expect(db.writes).toEqual([
      { kind: 'insert', table: 'app_data_migrations', values: { id: 'm1', attempts: 1 } },
      {
        kind: 'update',
        table: 'app_data_migrations',
        values: { completedAt: expect.any(Date), report: { touched: 3 }, lastError: null },
      },
    ])
  })

  it('skips a completed migration', async () => {
    const db = scriptedDb({ selects: [[{ attempts: 1, completedAt: new Date() }]] })
    const m = migration('m1', async () => ({}))
    await runDataMigrations(deps(db), [m])
    expect(m.run).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('records a failure (tried again next start) and goes on with the next', async () => {
    const db = scriptedDb({ selects: [[{ attempts: 1, completedAt: null }], []] })
    const error = vi.fn()
    const log = { ...quietLog, error } as unknown as FastifyBaseLogger
    const failing = migration('m1', async () => {
      throw Object.assign(new Error('boom'), { report: { failed: ['deck:d1'] } })
    })
    const next = migration('m2', async () => ({ ok: true }))
    await runDataMigrations(deps(db, log), [failing, next])
    expect(error).toHaveBeenCalledOnce()
    expect(db.writes[1]).toEqual({
      kind: 'update',
      table: 'app_data_migrations',
      values: { lastError: 'boom', report: { failed: ['deck:d1'] } },
    })
    expect(next.run).toHaveBeenCalledOnce()
  })

  it(`gives up after ${MAX_ATTEMPTS} failed tries`, async () => {
    const db = scriptedDb({ selects: [[{ attempts: MAX_ATTEMPTS, completedAt: null }]] })
    const error = vi.fn()
    const m = migration('m1', async () => ({}))
    await runDataMigrations(deps(db, { ...quietLog, error } as unknown as FastifyBaseLogger), [m])
    expect(m.run).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledOnce()
    expect(db.writes).toEqual([])
  })
})

describe('folderTokensOnServer', () => {
  it('seeds empty folders, migrates old seeds and re-styles lagging linked text', async () => {
    // f_empty: never opened in a browser — no tokens.
    const empty = await openDoc('folder:f_empty')
    // f_old: seeded before `builtin`, with a deck whose linked box lags its style.
    const old = new Y.Doc()
    addFolderToken(old, 'textStyles', 'body', { name: 'Body', size: 24 })
    persistence.snapshots.set('folder:f_old', Y.encodeStateAsUpdate(old))
    const oldLive = await openDoc('folder:f_old')
    const deck = createSlideDoc()
    const slideId = listSlides(deck)[0]!.id
    addObjects(getSlideObjectsCtx(deck, slideId)!, [
      {
        id: 'para',
        type: 'text',
        x: 0,
        y: 0,
        width: 400,
        height: 80,
        text: 'Hello',
        fontSize: 18,
        fontWeight: 400,
        color: 0,
        align: 'left',
        rotation: 0,
        opacity: 1,
        textStyleId: 'body',
      } satisfies TextObject,
    ])
    persistence.snapshots.set('d1', Y.encodeStateAsUpdate(deck.doc))
    const deckLive = await openDoc('d1')

    const db = scriptedDb({
      selects: [
        [{ id: 'f_empty' }, { id: 'f_old' }],
        // f_empty's decks and components (the seed's styles link nothing yet)
        [],
        [],
        // f_old's
        [{ id: 'd1' }],
        [],
      ],
    })
    const report = await folderTokensOnServer.run({
      db: db.db,
      log: quietLog,
      hocuspocus: () => hp,
    })
    expect(report).toEqual({
      folders: 2,
      seeded: 1,
      migrated: 1,
      decks: 1,
      components: 0,
      objects: 1,
      failed: [],
    })
    expect(Object.keys(readFolderTokens(empty).textStyles).length).toBeGreaterThan(0)
    expect(readFolderTokens(oldLive).textStyles['body']?.builtin).toBe(true)
    const para = (
      deckLive.getArray<Y.Map<unknown>>('slides').get(0).get('objects') as Y.Array<Y.Map<unknown>>
    ).get(0)
    expect(para.get('fontSize')).toBe(24)
  })

  it('fails (to be retried) when a folder could not be handled', async () => {
    // The folder list names a folder whose stored rows cannot be read.
    const db = scriptedDb({ selects: [[{ id: 'f_gone' }]] })
    await expect(
      folderTokensOnServer.run({ db: db.db, log: quietLog, hocuspocus: () => hp }),
    ).rejects.toThrow('some documents could not be migrated')
  })
})
