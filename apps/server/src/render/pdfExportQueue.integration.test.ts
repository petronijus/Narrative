/**
 * render/pdfExportQueue.integration.test.ts — the PDF export jobs on the real
 * media Redis (MEDIA_REDIS_URL, `just services`): a job is queued, run by
 * the worker with its progress, read back done with its result (or failed
 * with its reason), and a waiter wakes when it ends; slots are reserved
 * atomically under concurrent starts, leftovers are dropped, and a job a
 * stopped process left running is retried by the next worker. Every job and
 * slot key it adds is removed again.
 */

import { afterAll, describe, expect, it } from 'vitest'
import { nanoid } from 'nanoid'
import { Queue } from 'bullmq'
import { Redis as IORedis } from 'ioredis'
import {
  parsePdfExportFailure,
  pdfExportFailureMessage,
  type PdfExportJobData,
} from '@narrative/shared'
import {
  bullPdfExportQueue,
  PDF_EXPORT_SLOT_GRACE_MS,
  PDF_EXPORT_SLOT_TTL_MS,
  pdfExportQueueName,
  startPdfExportWorker,
} from './pdfExportQueue.js'
import { mediaRedisUrl } from './queue.js'

const ids: string[] = []
const data = (userId: string): PdfExportJobData => ({
  userId,
  deckId: `it-deck-${nanoid(6)}`,
  slides: 'all',
  includeSkipped: false,
  delivery: 'url',
})

let stop: (() => Promise<void>) | null = null
const users: string[] = []
const limits = { perUser: 2, global: 1000, startsPerWindow: 100, windowMs: 60_000 }
/**
 * Every worker here checks for stalled jobs often: BullMQ lets one check run
 * per `stalledInterval` across all workers of a queue, so a worker on the
 * default 30 s would hold off the next test's check for that long.
 */
const fast = { lockDurationMs: 3_000, stalledIntervalMs: 1_000 }

afterAll(async () => {
  await stop?.()
  const queue = new Queue(pdfExportQueueName, { connection: { url: mediaRedisUrl() } })
  for (const id of ids) await (await queue.getJob(id))?.remove().catch(() => undefined)
  await queue.close()
  const redis = new IORedis(mediaRedisUrl())
  for (const u of users)
    await redis.del(
      `narrative:${pdfExportQueueName}:slots:user:${u}`,
      `narrative:${pdfExportQueueName}:starts:${u}`,
    )
  if (ids.length > 0) await redis.zrem(`narrative:${pdfExportQueueName}:slots:all`, ...ids)
  await redis.quit()
})

const userSlotCount = async (userId: string): Promise<number> => {
  const redis = new IORedis(mediaRedisUrl())
  try {
    return await redis.zcard(`narrative:${pdfExportQueueName}:slots:user:${userId}`)
  } finally {
    await redis.quit()
  }
}

describe('the pdf-export queue on Redis', () => {
  it('runs a job with progress and hands its result back; a failure keeps its reason', async () => {
    const user = `it-user-${nanoid(6)}`
    users.push(user, `${user}-fails`)
    const release = new Map<string, () => void>()
    stop = startPdfExportWorker(async (job, progress) => {
      progress({ done: 1, total: 2 })
      await new Promise<void>((resolve) => release.set(job.deckId, resolve))
      if (job.userId.endsWith('-fails'))
        throw new Error(
          pdfExportFailureMessage({ code: 'not_found', status: 404, message: 'gone' }),
        )
      progress({ done: 2, total: 2 })
      return {
        key: `decks/${job.deckId}/exports/x/deck.pdf`,
        filename: 'Deck.pdf',
        pages: 2,
        leftOut: 0,
        sizeBytes: 10,
        failedLoads: 0,
        failedFonts: [],
      }
    }, fast)

    const ok = `pdf_${nanoid(12)}`
    ids.push(ok)
    const okData = data(user)
    expect(await bullPdfExportQueue.reserve(user, ok, limits)).toEqual({ ok: true })
    await bullPdfExportQueue.add(ok, okData)
    expect(await userSlotCount(user)).toBe(1)
    // Running, with its first progress.
    await expect
      .poll(async () => (await bullPdfExportQueue.get(ok))?.progress, { timeout: 10_000 })
      .toEqual({ done: 1, total: 2 })
    expect((await bullPdfExportQueue.get(ok))?.state).toBe('running')

    // A waiter wakes when the job ends, not at its timeout.
    const t0 = Date.now()
    const waited = bullPdfExportQueue.waitForEnd(ok, 20_000)
    await expect.poll(() => release.has(okData.deckId)).toBe(true)
    release.get(okData.deckId)!()
    await waited
    expect(Date.now() - t0).toBeLessThan(10_000)
    const done = await bullPdfExportQueue.get(ok)
    expect(done).toMatchObject({
      state: 'done',
      progress: { done: 2, total: 2 },
      result: { pages: 2, filename: 'Deck.pdf' },
      data: okData,
    })
    // The worker gave the slot back when the job ended.
    await expect.poll(() => userSlotCount(user)).toBe(0)

    const bad = `pdf_${nanoid(12)}`
    ids.push(bad)
    const badData = data(`${user}-fails`)
    await bullPdfExportQueue.add(bad, badData)
    await expect.poll(() => release.has(badData.deckId), { timeout: 10_000 }).toBe(true)
    release.get(badData.deckId)!()
    await bullPdfExportQueue.waitForEnd(bad, 10_000)
    const failed = await bullPdfExportQueue.get(bad)
    expect(failed?.state).toBe('failed')
    expect(parsePdfExportFailure(failed?.failedReason ?? undefined)).toEqual({
      code: 'not_found',
      status: 404,
      message: 'gone',
    })
    expect(await bullPdfExportQueue.get(`pdf_${nanoid(12)}`)).toBeNull()
    await stop!()
    stop = null
  }, 60_000)

  it('reserves slots atomically under concurrent starts, and counts starts per window', async () => {
    const user = `it-user-${nanoid(6)}`
    users.push(user)
    const jobIds = Array.from({ length: 10 }, () => `pdf_${nanoid(12)}`)
    ids.push(...jobIds)
    const outcomes = await Promise.all(
      jobIds.map((id) => bullPdfExportQueue.reserve(user, id, limits)),
    )
    expect(outcomes.filter((o) => o.ok)).toHaveLength(2)
    expect(outcomes.filter((o) => !o.ok && o.reason === 'user')).toHaveLength(8)
    // Given back: another may start.
    const held = jobIds.filter((_, i) => outcomes[i]!.ok)
    await bullPdfExportQueue.release(user, held[0]!)
    expect((await bullPdfExportQueue.reserve(user, jobIds[9]!, limits)).ok).toBe(true)

    // The start rate counts the accepted starts of the window (three so far).
    const rated = { ...limits, perUser: 100, startsPerWindow: 4 }
    expect((await bullPdfExportQueue.reserve(user, jobIds[8]!, rated)).ok).toBe(true)
    const refused = await bullPdfExportQueue.reserve(user, jobIds[7]!, rated)
    expect(refused).toMatchObject({ ok: false, reason: 'rate', count: 4 })
    expect(!refused.ok && refused.retryAfterMs).toBeGreaterThan(0)
  })

  it('drops a slot nobody gave back once it is past the grace and its job is gone', async () => {
    const user = `it-user-${nanoid(6)}`
    users.push(user)
    const leftover = `pdf_${nanoid(12)}`
    const fresh = `pdf_${nanoid(12)}`
    ids.push(leftover, fresh)
    const redis = new IORedis(mediaRedisUrl())
    try {
      // Reserved two minutes ago, for a job that was never queued.
      const lapses = Date.now() - PDF_EXPORT_SLOT_GRACE_MS * 2 + PDF_EXPORT_SLOT_TTL_MS
      await redis.zadd(`narrative:${pdfExportQueueName}:slots:user:${user}`, lapses, leftover)
      await redis.zadd(`narrative:${pdfExportQueueName}:slots:all`, lapses, leftover)
    } finally {
      await redis.quit()
    }
    const one = { ...limits, perUser: 1 }
    expect(await bullPdfExportQueue.reserve(user, fresh, one)).toEqual({ ok: true })
    expect(await userSlotCount(user)).toBe(1)
    // A young one is not taken for a leftover, job or not.
    expect(await bullPdfExportQueue.reserve(user, `pdf_${nanoid(12)}`, one)).toMatchObject({
      ok: false,
      reason: 'user',
    })
  })

  it('retries a job a stopped process left running, once, in the next worker', async () => {
    const user = `it-user-${nanoid(6)}`
    users.push(user)
    // Only this test's job counts: the queue is the dev stack's, shared.
    const mine = data(user)
    const runs: string[] = []
    const result = {
      key: 'decks/x/exports/y/deck.pdf',
      filename: 'Deck.pdf',
      pages: 1,
      leftOut: 0,
      sizeBytes: 10,
      failedLoads: 0,
      failedFonts: [],
    }
    // The first process: takes the job and never finishes it.
    const first = startPdfExportWorker(async (job) => {
      if (job.deckId === mine.deckId) runs.push('first')
      return new Promise<never>(() => undefined)
    }, fast)
    const id = `pdf_${nanoid(12)}`
    ids.push(id)
    expect((await bullPdfExportQueue.reserve(user, id, limits)).ok).toBe(true)
    await bullPdfExportQueue.add(id, mine)
    await expect.poll(() => runs.length, { timeout: 10_000 }).toBe(1)
    // Shutdown lets go of it at once (worker.close(true)): it stays active, its lock lapses.
    const t0 = Date.now()
    await first()
    expect(Date.now() - t0).toBeLessThan(3_000)

    stop = startPdfExportWorker(async (job) => {
      if (job.deckId === mine.deckId) runs.push('second')
      return result
    }, fast)
    await expect
      .poll(
        async () => {
          const job = await bullPdfExportQueue.get(id)
          return `${job?.state} ${job?.failedReason ?? ''}`.trim()
        },
        { timeout: 25_000 },
      )
      .toBe('done')
    expect(runs).toEqual(['first', 'second'])
    await expect.poll(() => userSlotCount(user)).toBe(0)
  }, 40_000)
})
