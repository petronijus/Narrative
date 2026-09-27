/**
 * agent/runStore.integration.test.ts — the Drizzle RunStore against a real
 * Postgres (migrations 0016 + 0017 applied). Excluded from `pnpm test`
 * (vitest.config.ts excludes *.integration.test.ts); run it against the
 * local dev database with `pnpm --filter @narrative/server test:integration`.
 *
 * It creates its own folder, deck, user and runs under random ids and
 * deletes them afterwards (runs and ops cascade with the deck). Note that
 * `closeAllOpen` has no filter by design, so that test also closes any run
 * a local dev server left open — run it against a dev database only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db, pool } from '../db/client.js'
import { agentRuns, decks, folders, users } from '../db/schema.js'
import { createDrizzleRunStore } from './runStore.js'

const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const deckId = `it-deck-${suffix}`
const store = createDrizzleRunStore(db)
const runIds: string[] = []

beforeAll(async () => {
  await db
    .insert(users)
    .values({ sub: userSub, email: `${userSub}@example.test`, name: 'Integration Tester' })
  await db.insert(folders).values({ id: folderId, ownerUserId: userSub, name: 'IT folder' })
  await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT deck' })
})

afterAll(async () => {
  if (runIds.length > 0) await db.delete(agentRuns).where(inArray(agentRuns.id, runIds))
  await db.delete(decks).where(eq(decks.id, deckId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await pool.end()
})

function newRun(
  id: string,
  createdAt: Date,
  extra: Partial<Parameters<typeof store.insertRun>[0]> = {},
) {
  runIds.push(id)
  return store.insertRun({
    id,
    userSub,
    deckId,
    componentId: null,
    surface: 'mcp',
    clientName: 'claude-code',
    request: 'Integration request',
    createdAt,
    ...extra,
  })
}

describe('Drizzle RunStore', () => {
  it('records runs and ops and lists them with names and op counts', async () => {
    const a = `run_it_a_${suffix}`
    const b = `run_it_b_${suffix}`
    await newRun(a, new Date('2026-09-26T10:00:00Z'))
    await newRun(b, new Date('2026-09-26T11:00:00Z'), {
      request: null,
      surface: 'api',
      clientName: null,
    })

    await store.insertOp({
      runId: a,
      seq: 1,
      command: 'object.update',
      input: { slide: 's1', object: 'r1', patch: { fill: '#ff0000' } },
      target: { deckId },
      result: { updated: ['r1'] },
      createdAt: new Date(),
    })
    await store.insertOp({
      runId: a,
      seq: 2,
      command: 'object.update',
      input: { slide: 's1', object: 'ghost', patch: {} },
      target: { deckId },
      error: { code: 'not_found', message: "object 'ghost' does not exist" },
      createdAt: new Date(),
    })
    await store.insertOp({
      runId: a,
      seq: 3,
      command: 'query.deck',
      input: {},
      target: { deckId },
      result: { slides: [] },
      createdAt: new Date(),
    })
    await expect(
      store.insertOp({
        runId: a,
        seq: 3,
        command: 'x',
        input: {},
        target: {},
        createdAt: new Date(),
      }),
    ).rejects.toThrow()

    const listed = await store.listRuns({ kind: 'deck', deckId }, 10)
    expect(listed.map((r) => r.id)).toEqual([b, a])
    const [, runA] = listed
    expect(runA).toMatchObject({
      userName: 'Integration Tester',
      status: 'open',
      clientName: 'claude-code',
    })
    expect(runA!.opCounts.sort((x, y) => x.command.localeCompare(y.command))).toEqual([
      { command: 'object.update', total: 2, succeeded: 1 },
      { command: 'query.deck', total: 1, succeeded: 1 },
    ])
    expect(listed[0]).toMatchObject({ request: null, surface: 'api', opCounts: [] })
  })

  it('moves runs through open → closed and → reverted', async () => {
    const id = `run_it_c_${suffix}`
    await newRun(id, new Date())
    await store.touchRun(id, new Date('2026-09-26T12:00:00Z'))
    expect((await store.getRun(id))?.lastActivityAt.toISOString()).toBe('2026-09-26T12:00:00.000Z')

    await store.markReverted(id, 'someone', new Date('2026-09-26T12:05:00Z'))
    await store.closeRun(id, new Date()) // a reverted run stays reverted
    const run = await store.getRun(id)
    expect(run).toMatchObject({ status: 'reverted', revertedBySub: 'someone' })
    expect(run?.closedAt?.toISOString()).toBe('2026-09-26T12:05:00.000Z')
  })

  it('closes runs left open by a previous process', async () => {
    const id = `run_it_d_${suffix}`
    await newRun(id, new Date())
    expect(await store.closeAllOpen(new Date())).toBeGreaterThanOrEqual(1)
    expect((await store.getRun(id))?.status).toBe('closed')
  })

  it('stores component runs (migration 0017) with no deck', async () => {
    const id = `run_it_e_${suffix}`
    await newRun(id, new Date(), { deckId: null })
    expect(await store.getRun(id)).toMatchObject({ deckId: null, componentId: null })
  })

  it('deletes closed runs idle before the cutoff, with their ops, in batches (retention)', async () => {
    // Dated in 2000 so the cutoff cannot touch any other run in a dev database.
    const old1 = `run_it_r1_${suffix}`
    const old2 = `run_it_r2_${suffix}`
    const old3 = `run_it_r3_${suffix}`
    const oldOpen = `run_it_r4_${suffix}`
    const recent = `run_it_r5_${suffix}`
    const t = new Date('2000-01-01T00:00:00Z')
    for (const id of [old1, old2, old3, oldOpen]) await newRun(id, t)
    await newRun(recent, new Date('2000-12-01T00:00:00Z'))
    for (const id of [old1, old2, old3, recent]) await store.closeRun(id, t)
    await store.insertOp({
      runId: old1,
      seq: 1,
      command: 'query.deck',
      input: {},
      target: {},
      createdAt: t,
    })

    const deleted = await store.deleteRunsInactiveBefore(new Date('2000-06-01T00:00:00Z'), 2)
    expect(deleted).toBe(3)
    for (const id of [old1, old2, old3]) expect(await store.getRun(id)).toBeNull()
    expect((await store.getRun(oldOpen))?.status).toBe('open')
    expect(await store.getRun(recent)).not.toBeNull()
    const [{ n }] = (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM agent_ops WHERE run_id = $1',
        [old1],
      )
    ).rows as [{ n: number }]
    expect(n).toBe(0)
  })

  it('reads the display name, never the email', async () => {
    expect(await store.userDisplayName(userSub)).toBe('Integration Tester')
    expect(await store.userDisplayName(`nobody-${suffix}`)).toBeNull()
  })
})
