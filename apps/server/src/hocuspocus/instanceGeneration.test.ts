/**
 * hocuspocus/instanceGeneration.test.ts — detecting a restored database at
 * boot (ADR 0017, security review M1): the marker backup.sh writes outside
 * Postgres against the generation the database holds.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../db/client.js'
import { checkForRestore, readRestoreMarker, restoredRow } from './instanceGeneration.js'

const log = () => ({ info: vi.fn(), warn: vi.fn() })

/** A database with one instance_generation row (or none) that records writes. */
function fakeDb(row: { generation: number; floor: number } | null) {
  const writes: Array<{ kind: 'update' | 'insert'; values: unknown }> = []
  const db = {
    select: () => ({
      from: () => ({ where: async () => (row === null ? [] : [row]) }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async () => {
          writes.push({ kind: 'update', values })
        },
      }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoNothing: async () => {
          writes.push({ kind: 'insert', values })
        },
      }),
    }),
  }
  return { db: db as unknown as Database, writes }
}

async function marker(value: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'narrative-marker-'))
  const file = path.join(dir, 'generation')
  await writeFile(file, value)
  return file
}

describe('restoredRow', () => {
  it('leaves a database that is not behind its marker alone', () => {
    expect(restoredRow({ generation: 200, floor: 1 }, 200, 999)).toBeNull()
    expect(restoredRow({ generation: 300, floor: 1 }, 200, 999)).toBeNull()
    expect(restoredRow({ generation: 200, floor: 1 }, null, 999)).toBeNull()
  })

  it('moves generation and floor past the marker and past now when the database is behind', () => {
    expect(restoredRow({ generation: 100, floor: 1 }, 160, 150)).toEqual({
      generation: 161,
      floor: 161,
    })
    expect(restoredRow({ generation: 100, floor: 1 }, 160, 5000)).toEqual({
      generation: 5000,
      floor: 5000,
    })
  })
})

describe('readRestoreMarker', () => {
  it('reads a positive integer, and nothing else', async () => {
    expect(await readRestoreMarker(await marker('1792540000\n'))).toBe(1792540000)
    for (const bad of ['', 'abc', '0', '-5', '1.5']) {
      expect(await readRestoreMarker(await marker(bad))).toBeNull()
    }
    expect(await readRestoreMarker(undefined)).toBeNull()
    expect(await readRestoreMarker('/nonexistent/narrative/marker')).toBeNull()
  })
})

describe('checkForRestore', () => {
  it('detects a restore: the database below the marker raises generation and floor', async () => {
    const { db, writes } = fakeDb({ generation: 100, floor: 1 })
    const l = log()
    const out = await checkForRestore({
      db,
      log: l,
      markerPath: await marker('160'),
      now: () => 120,
    })
    expect(out).toEqual({ restored: true, row: { generation: 161, floor: 161 } })
    expect(writes).toEqual([{ kind: 'update', values: { generation: 161, floor: 161 } }])
    expect(l.warn).toHaveBeenCalled()
  })

  it('changes nothing for a database at or above its marker (daily backups move only the generation)', async () => {
    const { db, writes } = fakeDb({ generation: 160, floor: 1 })
    const out = await checkForRestore({ db, log: log(), markerPath: await marker('160') })
    expect(out.restored).toBe(false)
    expect(writes).toEqual([])
  })

  it('cannot detect anything without a marker, and says so', async () => {
    const { db, writes } = fakeDb({ generation: 100, floor: 1 })
    const l = log()
    const out = await checkForRestore({ db, log: l, markerPath: undefined })
    expect(out.restored).toBe(false)
    expect(writes).toEqual([])
    expect(l.info).toHaveBeenCalled()
  })

  it('treats a missing row (a dump from before migration 0042) as a restore', async () => {
    const { db, writes } = fakeDb(null)
    const out = await checkForRestore({
      db,
      log: log(),
      markerPath: await marker('160'),
      now: () => 120,
    })
    expect(out).toEqual({ restored: true, row: { generation: 161, floor: 161 } })
    expect(writes[0]?.kind).toBe('insert')
  })
})
