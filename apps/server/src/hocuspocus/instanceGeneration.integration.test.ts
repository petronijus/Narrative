/**
 * hocuspocus/instanceGeneration.integration.test.ts — the restore generation
 * in a real Postgres (ADR 0017, migration 0042): what backup.sh does after a
 * dump (advance the generation only) and what a boot after a restore does
 * (raise generation and floor past the marker), read back the way the sync
 * server reads them. Restores the row afterwards. Excluded from `pnpm test`;
 * run with `just integration`.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { instanceGeneration } from '../db/schema.js'
import { advanceGeneration, checkForRestore } from './instanceGeneration.js'

let saved: { generation: number; floor: number } | null = null
const quiet = { info: () => undefined, warn: () => undefined }

beforeAll(async () => {
  const rows = await db.select().from(instanceGeneration).where(eq(instanceGeneration.id, 1))
  saved =
    rows[0] === undefined
      ? null
      : { generation: Number(rows[0].generation), floor: Number(rows[0].floor) }
})

afterAll(async () => {
  if (saved !== null) {
    await db.update(instanceGeneration).set(saved).where(eq(instanceGeneration.id, 1))
  }
  await pool.end()
})

describe('instance generation', () => {
  it('has its row from migration 0042', () => {
    expect(saved).not.toBeNull()
    expect(saved!.floor).toBeLessThanOrEqual(saved!.generation)
  })

  it('advances the generation, never the floor (a backup)', async () => {
    const before = saved!
    const next = await advanceGeneration(db, 1)
    expect(next).toBe(before.generation + 1)
    const now = Math.floor(Date.now() / 1000) + 10
    expect(await advanceGeneration(db, now)).toBe(Math.max(next + 1, now))
    const [row] = await db.select().from(instanceGeneration).where(eq(instanceGeneration.id, 1))
    expect(Number(row!.floor)).toBe(before.floor)
  })

  it('raises generation and floor when the database is behind the marker (a restore)', async () => {
    const [row] = await db.select().from(instanceGeneration).where(eq(instanceGeneration.id, 1))
    const dir = await mkdtemp(path.join(tmpdir(), 'narrative-marker-'))
    const file = path.join(dir, 'generation')
    const markerValue = Number(row!.generation) + 1000
    await writeFile(file, `${markerValue}\n`)
    const out = await checkForRestore({ db, log: quiet, markerPath: file, now: () => 1 })
    expect(out).toEqual({
      restored: true,
      row: { generation: markerValue + 1, floor: markerValue + 1 },
    })
    const [after] = await db.select().from(instanceGeneration).where(eq(instanceGeneration.id, 1))
    expect(Number(after!.floor)).toBe(markerValue + 1)
    // A second boot with the same marker changes nothing.
    expect((await checkForRestore({ db, log: quiet, markerPath: file })).restored).toBe(false)
  })
})
