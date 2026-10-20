/**
 * media/ownerSweeps.integration.test.ts — the second sweep of a deleted
 * owner, against the Postgres and the MinIO the stack runs (migration 0040
 * applied). Excluded from `pnpm test`; run with `just integration`. Its rows
 * and objects use random ids; what a test leaves is removed afterwards.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { db } from '../db/client.js'
import { decks, folders, mediaOwnerSweeps, users } from '../db/schema.js'
import { buildS3Client, MEDIA_BUCKET } from './s3Client.js'
import { purgeExplicitKeys } from './bucketCleanup.js'
import {
  OWNER_SWEEP_LEASE_MS,
  OWNER_SWEEP_MAX_ATTEMPTS,
  ownerSweepDelayMs,
  runDueOwnerSweeps,
  scheduleOwnerSweeps,
} from './ownerSweeps.js'

const s3 = buildS3Client()
const log = { info() {}, warn() {} }
const suffix = nanoid(8)
const userSub = `it-user-${suffix}`
const folderId = `it-folder-${suffix}`
const createdKeys: string[] = []
const createdOwners: string[] = []

async function stored(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function put(key: string): Promise<void> {
  createdKeys.push(key)
  await s3.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Body: Buffer.from('x') }))
}

async function rowOf(kind: 'deck' | 'component', id: string) {
  const [row] = await db
    .select()
    .from(mediaOwnerSweeps)
    .where(and(eq(mediaOwnerSweeps.ownerKind, kind), eq(mediaOwnerSweeps.ownerId, id)))
  return row
}

/** Due a moment ago, whatever the grace window says. */
const later = () => Date.now() + ownerSweepDelayMs() + 1_000

// The objects here were written a moment ago: a zero grace window lets the
// sweep take them (the window itself is bucketCleanup.ts's, tested there).
beforeAll(() => {
  vi.stubEnv('MEDIA_SWEEP_GRACE_MS', '0')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  for (const id of createdOwners) {
    await db.delete(mediaOwnerSweeps).where(eq(mediaOwnerSweeps.ownerId, id))
  }
  await db.delete(decks).where(eq(decks.folderId, folderId))
  await db.delete(folders).where(eq(folders.id, folderId))
  await db.delete(users).where(eq(users.sub, userSub))
  await purgeExplicitKeys(createdKeys, log)
})

describe('owner sweeps', () => {
  it('sweeps a deleted deck once due, and forgets it', async () => {
    const deckId = `it-sw-${nanoid(8)}`
    createdOwners.push(deckId)
    const key = `decks/${deckId}/thumb-x.png`
    await put(key)
    await scheduleOwnerSweeps(db, [{ deckId }])

    // Not due yet: nothing runs.
    const early = await runDueOwnerSweeps(db, log, { now: Date.now() })
    expect(early.swept).toBe(0)
    expect(await stored(key)).toBe(true)

    // Due: the object is older than a zero grace window, no row names it.
    const due = await runDueOwnerSweeps(db, log, { now: later() })
    expect(due.swept).toBeGreaterThanOrEqual(1)
    expect(await stored(key)).toBe(false)
    expect(await rowOf('deck', deckId)).toBeUndefined()
  })

  it('drops the sweep of an owner that exists, unswept', async () => {
    await db.insert(users).values({ sub: userSub, email: `${userSub}@example.test`, name: 'IT' })
    await db.insert(folders).values({ id: folderId, ownerUserId: userSub, name: 'IT' })
    const deckId = `it-sw-${nanoid(8)}`
    createdOwners.push(deckId)
    await db.insert(decks).values({ id: deckId, ownerUserId: userSub, folderId, title: 'IT' })
    const key = `decks/${deckId}/thumb-live.png`
    await put(key)
    await scheduleOwnerSweeps(db, [{ deckId }])

    const report = await runDueOwnerSweeps(db, log, { now: later() })
    expect(report.dropped).toBeGreaterThanOrEqual(1)
    expect(await stored(key)).toBe(true)
    expect(await rowOf('deck', deckId)).toBeUndefined()
  })

  it('takes a row once: a second run within its lease skips it', async () => {
    const componentId = `it-sw-${nanoid(8)}`
    createdOwners.push(componentId)
    await scheduleOwnerSweeps(db, [{ componentId }])
    const now = later()
    // A row is taken by moving its due time a lease forward.
    await db
      .update(mediaOwnerSweeps)
      .set({ dueAt: new Date(now + OWNER_SWEEP_LEASE_MS) })
      .where(eq(mediaOwnerSweeps.ownerId, componentId))
    const report = await runDueOwnerSweeps(db, log, { now })
    expect(report.swept + report.dropped).toBe(0)
    expect(await rowOf('component', componentId)).toBeDefined()
    // Once the lease has run out, it runs.
    await runDueOwnerSweeps(db, log, { now: now + OWNER_SWEEP_LEASE_MS + 1_000 })
    expect(await rowOf('component', componentId)).toBeUndefined()
  })

  it('a second schedule of the same owner makes it due again from now, attempts reset', async () => {
    const deckId = `it-sw-${nanoid(8)}`
    createdOwners.push(deckId)
    await scheduleOwnerSweeps(db, [{ deckId }, { deckId }], Date.now() - 60 * 60_000)
    await db
      .update(mediaOwnerSweeps)
      .set({ attempts: OWNER_SWEEP_MAX_ATTEMPTS - 1 })
      .where(eq(mediaOwnerSweeps.ownerId, deckId))
    const now = Date.now()
    await scheduleOwnerSweeps(db, [{ deckId }], now)
    const row = await rowOf('deck', deckId)
    expect(row?.attempts).toBe(0)
    expect(row?.dueAt.getTime()).toBe(now + ownerSweepDelayMs())
  })
})
