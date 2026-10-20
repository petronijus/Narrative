/**
 * render/pdfExportQueue.ts — the BullMQ queue `pdf-export` (PDF_EXPORT_QUEUE,
 * @narrative/shared): deck PDFs made as jobs, so no request waits for one
 * (docs/plans/performance.md, R1). The server adds the job and answers with
 * its id; a worker in the server process runs it (`startPdfExportWorker`,
 * services/render.ts `runPdfExport`: the slides through the render worker's
 * queue, then the file into the bucket); the editor and the agent read the
 * job's state, progress and result here.
 *
 * On the media Redis like the render queue. Jobs are kept an hour after they
 * end (their files are swept after a day, services/exportSweep.ts). A job
 * left running by a process that stopped is retried once by the next one
 * (BullMQ's stalled check), from the start; a failed one is not retried —
 * its reason (the service error, `pdfExportFailureMessage`) is what the
 * poller hears.
 *
 * Slots. Who may queue a job is decided by one Redis script (`reserve`), so
 * two requests arriving together cannot both pass a count read before either
 * added its job: it drops reservations past their time, checks the person's
 * starts in the current window, their jobs and everyone's, and takes a slot
 * in both sets in one step. A slot is the job's id in a sorted set scored by
 * when it lapses (`PDF_EXPORT_SLOT_TTL_MS`). It is given back when the job
 * ends (the worker's `completed`/`failed`, and the queue's `failed` event for
 * a job BullMQ fails for stalling too often), when the job could not be
 * added, and — should all of those be missed (a process killed between two
 * of them) — by `reserve` itself: refused, it looks at the slots older than a
 * minute whose job no longer waits or runs, drops them and tries once more.
 * The lapse time is the last resort.
 */

import { Queue, QueueEvents, Worker, type Job } from 'bullmq'
import type { Redis as IORedis } from 'ioredis'
import {
  PDF_EXPORT_QUEUE,
  type PdfExportJobData,
  type PdfExportJobResult,
  type PdfExportProgress,
} from '@narrative/shared'
import { subsystemLogger } from '../observability/logger.js'
import {
  mediaRedisUrl,
  redisConnection,
  REDIS_CALL_TIMEOUT_MS,
  RenderUnavailableError,
  within,
} from './queue.js'

const log = subsystemLogger('pdf-export-queue')

/** How long a finished job (and its result) is kept for its poller. */
export const PDF_EXPORT_JOB_RETENTION_SEC = 3600
/** PDF jobs the server's worker runs at once (each renders 20 slides at a time). */
export const PDF_EXPORT_CONCURRENCY = 2
/**
 * When a slot nobody gave back lapses: longer than a job can wait and run
 * (20 queued jobs, two at a time, ten minutes each: 100 minutes, plus its own).
 */
export const PDF_EXPORT_SLOT_TTL_MS = 2 * 60 * 60_000
/** A slot this young is never taken for a leftover: its job may not be added yet. */
export const PDF_EXPORT_SLOT_GRACE_MS = 60_000
/**
 * While a poller waits, the job's state is also read this often: the events
 * stream is read from "now" once its connection is up, so an end that falls
 * between the state check and its first read is never heard as an event.
 */
export const PDF_EXPORT_WAIT_POLL_MS = 2_000

/** A job as a poller sees it. */
export interface PdfExportJobView {
  id: string
  data: PdfExportJobData
  state: 'queued' | 'running' | 'done' | 'failed'
  progress: PdfExportProgress | null
  result: PdfExportJobResult | null
  failedReason: string | null
}

/** The bounds a reservation is held to. */
export interface PdfSlotLimits {
  /** Jobs one person may have waiting or running. */
  perUser: number
  /** Jobs everyone may have waiting or running. */
  global: number
  /** Jobs one person may start in a window of `windowMs`. */
  startsPerWindow: number
  windowMs: number
}

/** What a reservation came to. */
export type PdfSlotOutcome =
  | { ok: true }
  | {
      ok: false
      /** `user`: their own jobs; `global`: everyone's; `rate`: their starts in the window. */
      reason: 'user' | 'global' | 'rate'
      count: number
      /** For `rate`: when the window ends. */
      retryAfterMs?: number
    }

/** How the render service reaches the PDF jobs (a fake in tests). */
export interface PdfExportQueue {
  /**
   * Take a slot for `jobId`, atomically against every other reservation;
   * `RenderUnavailableError` when Redis cannot answer.
   */
  reserve(userId: string, jobId: string, limits: PdfSlotLimits): Promise<PdfSlotOutcome>
  /** Give the slot of `jobId` back (idempotent; never throws). */
  release(userId: string, jobId: string): Promise<void>
  /** Queue a job under `jobId`; `RenderUnavailableError` when Redis cannot take it. */
  add(jobId: string, data: PdfExportJobData): Promise<void>
  /** The job, or null when there is none (never was, or expired). */
  get(jobId: string): Promise<PdfExportJobView | null>
  /** Resolves when the job has ended, or after `waitMs`, whichever is first. */
  waitForEnd(jobId: string, waitMs: number): Promise<void>
}

/**
 * The queue's name: `pdf-export` (PDF_EXPORT_QUEUE), or PDF_EXPORT_QUEUE_NAME
 * when set — the integration tests run on their own queue (and slot keys), so
 * the worker of a dev server on the same Redis never takes their jobs.
 */
export const pdfExportQueueName: string = process.env['PDF_EXPORT_QUEUE_NAME'] ?? PDF_EXPORT_QUEUE

const SLOT_PREFIX = `narrative:${pdfExportQueueName}`
const userSlots = (userId: string): string => `${SLOT_PREFIX}:slots:user:${userId}`
const allSlots = `${SLOT_PREFIX}:slots:all`
const userStarts = (userId: string): string => `${SLOT_PREFIX}:starts:${userId}`

/**
 * KEYS: the person's slots, everyone's slots, the person's starts counter.
 * ARGV: now, the slot's lapse time, the job id, perUser, global,
 * startsPerWindow, windowMs, the sets' own expiry (ms).
 * Returns { 'ok' } or { reason, count, retryAfterMs }.
 */
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local starts = tonumber(redis.call('GET', KEYS[3]) or '0')
if starts >= tonumber(ARGV[6]) then
  local left = redis.call('PTTL', KEYS[3])
  return { 'rate', starts, left }
end
local mine = redis.call('ZCARD', KEYS[1])
if mine >= tonumber(ARGV[4]) then return { 'user', mine, 0 } end
local all = redis.call('ZCARD', KEYS[2])
if all >= tonumber(ARGV[5]) then return { 'global', all, 0 } end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[8])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
if redis.call('INCR', KEYS[3]) == 1 then redis.call('PEXPIRE', KEYS[3], ARGV[7]) end
return { 'ok', 0, 0 }
`

let shared: {
  queue: Queue<PdfExportJobData, PdfExportJobResult>
  events: QueueEvents
  /** The queue's own connection, for the slot sets (no offline queue: a call fails fast). */
  redis: IORedis
  close: () => Promise<void>
} | null = null

function connect() {
  if (shared !== null) return shared
  const connections = [
    redisConnection(mediaRedisUrl(), 'pdf-queue', { offlineQueue: false }),
    redisConnection(mediaRedisUrl(), 'pdf-events', { offlineQueue: true }),
  ]
  const queue = new Queue<PdfExportJobData, PdfExportJobResult>(pdfExportQueueName, {
    connection: connections[0]!,
  })
  const events = new QueueEvents(pdfExportQueueName, { connection: connections[1]! })
  queue.on('error', (err) => log.warn({ err: err.message }, 'pdf export queue connection error'))
  events.on('error', (err) => log.warn({ err: err.message }, 'pdf export queue events error'))
  // Many pollers may wait on one job; each adds its listeners for a while.
  events.setMaxListeners(0)
  shared = {
    queue,
    events,
    redis: connections[0]!,
    close: async () => {
      await within(
        Promise.allSettled([events.close(), queue.close()]),
        Date.now() + REDIS_CALL_TIMEOUT_MS,
        () => new Error('close timed out'),
      ).catch(() => {
        for (const c of connections) c.disconnect()
      })
    },
  }
  return shared
}

const bounded = <T>(p: Promise<T>, what: string): Promise<T> =>
  within(
    p,
    Date.now() + REDIS_CALL_TIMEOUT_MS,
    () => new RenderUnavailableError(`the PDF export queue did not ${what} in time`),
  )

const unavailable = (err: unknown): RenderUnavailableError =>
  err instanceof RenderUnavailableError
    ? err
    : new RenderUnavailableError(
        `the PDF export queue is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      )

async function view(job: Job<PdfExportJobData, PdfExportJobResult>): Promise<PdfExportJobView> {
  const state = await job.getState()
  const progress =
    typeof job.progress === 'object' && job.progress !== null
      ? (job.progress as unknown as PdfExportProgress)
      : null
  return {
    id: job.id!,
    data: job.data,
    state:
      state === 'completed'
        ? 'done'
        : state === 'failed'
          ? 'failed'
          : state === 'active'
            ? 'running'
            : 'queued',
    progress,
    result: state === 'completed' ? (job.returnvalue ?? null) : null,
    failedReason: state === 'failed' ? (job.failedReason ?? null) : null,
  }
}

const ENDED = new Set(['completed', 'failed', 'unknown'])

/** The slot sets' connection, once it is up (it has no offline queue to wait in). */
async function redis(): Promise<IORedis> {
  const { queue, redis } = connect()
  await queue.waitUntilReady()
  return redis
}

async function reserveOnce(
  client: IORedis,
  userId: string,
  jobId: string,
  limits: PdfSlotLimits,
): Promise<PdfSlotOutcome> {
  const now = Date.now()
  const answer = (await client.eval(
    RESERVE_SCRIPT,
    3,
    userSlots(userId),
    allSlots,
    userStarts(userId),
    String(now),
    String(now + PDF_EXPORT_SLOT_TTL_MS),
    jobId,
    String(limits.perUser),
    String(limits.global),
    String(limits.startsPerWindow),
    String(limits.windowMs),
    String(PDF_EXPORT_SLOT_TTL_MS),
  )) as [string, number, number]
  const [reason, count, left] = answer
  if (reason === 'ok') return { ok: true }
  return {
    ok: false,
    reason: reason as 'user' | 'global' | 'rate',
    count,
    ...(reason === 'rate' ? { retryAfterMs: Math.max(0, left) } : {}),
  }
}

/**
 * Drop the slots of `key` older than the grace whose job no longer waits or
 * runs (missed releases); how many went.
 */
async function dropLeftovers(client: IORedis, key: string): Promise<number> {
  const { queue } = connect()
  const reservedBefore = Date.now() - PDF_EXPORT_SLOT_GRACE_MS
  // A slot's score is when it lapses: reserved before `reservedBefore` ⇔ score below this.
  const members = await client.zrangebyscore(
    key,
    '-inf',
    String(reservedBefore + PDF_EXPORT_SLOT_TTL_MS),
  )
  let dropped = 0
  for (const jobId of members) {
    const job = await queue.getJob(jobId)
    const state = job === undefined ? 'unknown' : await job.getState()
    if (!ENDED.has(state)) continue
    await client.zrem(key, jobId)
    if (key !== allSlots) await client.zrem(allSlots, jobId)
    else if (job !== undefined) await client.zrem(userSlots(job.data.userId), jobId)
    dropped++
  }
  return dropped
}

/** Give the slot back; logged, never thrown (the lapse time is the fallback). */
async function releaseSlot(userId: string, jobId: string): Promise<void> {
  try {
    const client = await redis()
    await bounded(
      client.multi().zrem(userSlots(userId), jobId).zrem(allSlots, jobId).exec(),
      'give a slot back',
    )
  } catch (err) {
    log.warn({ err: (err as Error).message, jobId }, 'pdf export: a slot was not given back')
  }
}

export const bullPdfExportQueue: PdfExportQueue = {
  async reserve(userId, jobId, limits) {
    try {
      const client = await bounded(redis(), 'answer')
      const first = await bounded(reserveOnce(client, userId, jobId, limits), 'answer')
      if (first.ok || first.reason === 'rate') return first
      const dropped = await bounded(
        dropLeftovers(client, first.reason === 'user' ? userSlots(userId) : allSlots),
        'answer',
      )
      if (dropped === 0) return first
      log.info({ dropped, reason: first.reason }, 'pdf export: dropped slots nobody gave back')
      return await bounded(reserveOnce(client, userId, jobId, limits), 'answer')
    } catch (err) {
      throw unavailable(err)
    }
  },
  release: releaseSlot,
  async add(jobId, data) {
    const { queue } = connect()
    try {
      await bounded(
        queue.add('pdf', data, {
          jobId,
          attempts: 1,
          removeOnComplete: { age: PDF_EXPORT_JOB_RETENTION_SEC },
          removeOnFail: { age: PDF_EXPORT_JOB_RETENTION_SEC },
        }),
        'accept the job',
      )
    } catch (err) {
      throw unavailable(err)
    }
  },
  async get(jobId) {
    const job = await bounded(connect().queue.getJob(jobId), 'answer')
    return job === undefined ? null : bounded(view(job), 'answer')
  },
  async waitForEnd(jobId, waitMs) {
    if (waitMs <= 0) return
    const { queue, events } = connect()
    const until = Date.now() + waitMs
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let poll: ReturnType<typeof setInterval> | undefined
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poll)
        events.off('completed', onEnd)
        events.off('failed', onEnd)
        resolve()
      }
      const onEnd = (args: { jobId: string }): void => {
        if (args.jobId === jobId) done()
      }
      const check = async (): Promise<void> => {
        const job = await queue.getJob(jobId)
        if (job === undefined) return done()
        if (ENDED.has(await job.getState())) done()
      }
      events.on('completed', onEnd)
      events.on('failed', onEnd)
      timer = setTimeout(done, waitMs)
      // Listening first, then — once the events connection is up — the
      // state, then the state again every so often: an end before the
      // stream is read, or between the check and the first read, still wakes
      // the poller.
      void within(events.waitUntilReady(), until, () => new Error('not ready'))
        .catch(() => undefined)
        .then(async () => {
          if (settled) return
          poll = setInterval(() => void check().catch(done), PDF_EXPORT_WAIT_POLL_MS)
          await check()
        })
        .catch(done)
    })
  },
}

/** How the server's worker is run (tests shorten BullMQ's lock and stall checks). */
export interface PdfExportWorkerOptions {
  /** BullMQ `lockDuration` (default 30 s). */
  lockDurationMs?: number
  /** BullMQ `stalledInterval` (default 30 s). */
  stalledIntervalMs?: number
}

/**
 * Run the PDF export jobs in this process: `run` makes one job's file, and
 * reports pages as they render. Returns a stop function for shutdown: it lets
 * go of the jobs in progress at once (`worker.close(true)`, no waiting for
 * them — the process is about to end, and a job whose lock lapses is retried
 * by the next process, `maxStalledCount: 1`), so it never holds up the
 * shutdown that has documents to store (index.ts, shutdown.ts).
 */
export function startPdfExportWorker(
  run: (
    data: PdfExportJobData,
    progress: (p: PdfExportProgress) => void,
  ) => Promise<PdfExportJobResult>,
  opts: PdfExportWorkerOptions = {},
): () => Promise<void> {
  const connection = redisConnection(mediaRedisUrl(), 'pdf-worker', { offlineQueue: true })
  const worker = new Worker<PdfExportJobData, PdfExportJobResult>(
    pdfExportQueueName,
    async (job) =>
      run(job.data, (p) => {
        void job.updateProgress(p as unknown as object).catch(() => undefined)
      }),
    {
      connection,
      concurrency: PDF_EXPORT_CONCURRENCY,
      // A job left behind by a stopped process is started again once, no more.
      maxStalledCount: 1,
      ...(opts.lockDurationMs !== undefined ? { lockDuration: opts.lockDurationMs } : {}),
      ...(opts.stalledIntervalMs !== undefined ? { stalledInterval: opts.stalledIntervalMs } : {}),
    },
  )
  const ended = (job: Job<PdfExportJobData> | undefined): void => {
    if (job?.id !== undefined) void releaseSlot(job.data.userId, job.id)
  }
  worker.on('error', (err) => log.warn({ err: err.message }, 'pdf export worker error'))
  worker.on('completed', (job) => ended(job))
  worker.on('failed', (job, err) => {
    log.info({ jobId: job?.id, err: err.message }, 'pdf export job failed')
    ended(job)
  })
  // A job BullMQ fails for stalling too often is failed by a script, not by
  // a worker's processor: only the queue's events say so.
  const { queue, events } = connect()
  const onQueueFailed = ({ jobId }: { jobId: string }): void => {
    void queue
      .getJob(jobId)
      .then((job) => ended(job))
      .catch(() => undefined)
  }
  events.on('failed', onQueueFailed)
  return async () => {
    events.off('failed', onQueueFailed)
    await within(
      worker.close(true),
      Date.now() + REDIS_CALL_TIMEOUT_MS,
      () => new Error('close timed out'),
    ).catch(() => connection.disconnect())
    if (shared !== null) {
      const s = shared
      shared = null
      await s.close()
    }
  }
}
