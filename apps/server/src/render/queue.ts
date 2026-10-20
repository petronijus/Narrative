/**
 * render/queue.ts — the server's side of the BullMQ queue `render`
 * (RENDER_QUEUE, @narrative/shared): add a job for the render worker
 * (apps/render-worker) and wait for its result.
 *
 * On the media Redis (MEDIA_REDIS_URL), like the video transcode queue. One
 * Queue and one QueueEvents per process, created on first use. With Redis
 * down the caller hears "renderer unavailable" within seconds, never hangs:
 * the producer keeps no offline queue, and every call that has to reach Redis
 * is bounded (a connection that has never been ready waits for it forever —
 * BullMQ's `client` promise — whatever the offline queue says).
 *
 * Jobs carry a BullMQ priority (lower runs first; the service passes the
 * slides the caller has in flight), so one person's long jobs do not keep
 * everyone else's waiting.
 */

import { Queue, QueueEvents } from 'bullmq'
import { Redis as IORedis } from 'ioredis'
import { RENDER_QUEUE, type RenderJobData, type RenderJobResult } from '@narrative/shared'
import { subsystemLogger } from '../observability/logger.js'

const log = subsystemLogger('render-queue')

/** The job did not finish before its deadline (the caller stopped waiting). */
export class RenderTimeoutError extends Error {
  /**
   * @param started whether the worker had begun the job: false means it
   *   waited in the queue the whole time (the renderer was busy).
   */
  constructor(readonly started = true) {
    super('the render did not finish in time')
  }
}

/** The renderer cannot take the job now (Redis down, or too many jobs waiting). */
export class RenderUnavailableError extends Error {}

/** How the render service reaches the worker (a fake in tests). */
export interface RenderQueue {
  /**
   * Run one job and wait until `data.deadline` for its result. Rejects with
   * the job's failure message, `RenderTimeoutError` at the deadline, or
   * `RenderUnavailableError` when the job cannot be queued. `priority` ≥ 1,
   * lower first.
   */
  run(data: RenderJobData, opts: { priority: number }): Promise<RenderJobResult>
  /** Jobs queued but not started (`RenderUnavailableError` when Redis cannot say). */
  waiting(): Promise<number>
}

/** How long a call that only has to reach Redis may take before Redis counts as down. */
export const REDIS_CALL_TIMEOUT_MS = 3_000

let shared: {
  queue: Queue<RenderJobData, RenderJobResult>
  events: QueueEvents
  connections: IORedis[]
} | null = null

/**
 * A connection to the media Redis whose errors are logged — once per outage,
 * not on every reconnect attempt (ioredis retries every few seconds, and an
 * error with no listener is printed as "Unhandled error event").
 */
export function redisConnection(
  url: string,
  name: string,
  opts: { offlineQueue: boolean },
): IORedis {
  // maxRetriesPerRequest: null is required by BullMQ (it manages retries).
  const connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: opts.offlineQueue,
  })
  let down = false
  connection.on('error', (err: Error) => {
    if (down) return
    down = true
    log.warn({ err: err.message, connection: name }, 'render queue: media Redis unreachable')
  })
  connection.on('ready', () => {
    if (down) log.info({ connection: name }, 'render queue: media Redis reachable again')
    down = false
  })
  return connection
}

/** The media Redis the render and PDF export queues live on. */
export const mediaRedisUrl = (): string =>
  process.env['MEDIA_REDIS_URL'] ?? 'redis://127.0.0.1:6380'

function connect() {
  if (shared !== null) return shared
  const redisUrl = mediaRedisUrl()
  // A QueueEvents holds a blocking connection, so it gets its own.
  const connections = [
    redisConnection(redisUrl, 'queue', { offlineQueue: false }),
    redisConnection(redisUrl, 'events', { offlineQueue: true }),
  ]
  const queue = new Queue<RenderJobData, RenderJobResult>(RENDER_QUEUE, {
    connection: connections[0]!,
  })
  const events = new QueueEvents(RENDER_QUEUE, { connection: connections[1]! })
  // A Redis blip is logged here, not left to the process's uncaught handler.
  queue.on('error', (err) => log.warn({ err: err.message }, 'render queue connection error'))
  events.on('error', (err) => log.warn({ err: err.message }, 'render queue events error'))
  shared = { queue, events, connections }
  return shared
}

/** `promise`, or `onTimeout()` thrown at `deadline`. */
export async function within<T>(
  promise: Promise<T>,
  deadline: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const unavailable = (what: string) => () =>
  new RenderUnavailableError(`the render queue did not ${what} in time (is the media Redis up?)`)

/** The process-wide queue to the render worker. */
export const bullRenderQueue: RenderQueue = {
  async run(data, opts) {
    const { queue, events } = connect()
    let job
    try {
      job = await within(
        queue.add('render', data, {
          // No retries: the caller waits, and a retry would outlive its token.
          attempts: 1,
          priority: Math.max(1, Math.round(opts.priority)),
          removeOnComplete: { age: 600, count: 50 },
          removeOnFail: { age: 3600, count: 100 },
        }),
        Math.min(data.deadline, Date.now() + REDIS_CALL_TIMEOUT_MS),
        unavailable('accept the job'),
      )
    } catch (err) {
      if (err instanceof RenderUnavailableError) throw err
      throw new RenderUnavailableError(
        `the render queue is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    try {
      const result = await within(
        // Its own timer a second later only cleans up its listeners; `within`
        // decides, so one clock says when the caller stopped waiting.
        job.waitUntilFinished(events, Math.max(1, data.deadline - Date.now()) + 1_000),
        data.deadline,
        () => new RenderTimeoutError(),
      )
      // The record holds the render session's token, which outlives the job:
      // it goes once its result is in, not minutes later.
      await job.remove().catch(() => undefined)
      return result
    } catch (err) {
      // Not finished in time: take it out of the queue if it has not started
      // (a running job stops itself at the deadline, apps/render-worker).
      // A timer may fire a millisecond before Date.now() reaches the
      // deadline (libuv's cached loop time), so the error decides first.
      if (err instanceof RenderTimeoutError || Date.now() >= data.deadline) {
        const state = await job.getState().catch(() => 'unknown')
        await job.remove().catch(() => undefined)
        throw new RenderTimeoutError(
          !(state === 'waiting' || state === 'prioritized' || state === 'delayed'),
        )
      }
      // A failed job's record goes too (its error is in the worker's log).
      await job.remove().catch(() => undefined)
      throw err
    }
  },
  async waiting() {
    return within(
      connect().queue.getJobCountByTypes('waiting', 'prioritized'),
      Date.now() + REDIS_CALL_TIMEOUT_MS,
      unavailable('answer'),
    )
  },
}

/**
 * Drop the jobs a previous server process left waiting: their render tokens
 * lived in its memory, so a page opened with one would only be refused (and
 * count against the worker's failed-login limit). Called at start, after the
 * server listens, so it removes only jobs queued before `startedAt` — a
 * request that comes in meanwhile keeps its job. Returns how many it removed.
 */
export async function dropStaleRenderJobs(startedAt: number): Promise<number> {
  const { queue } = connect()
  const waiting = await queue.getJobs(['waiting', 'prioritized'])
  const stale = waiting.filter((job) => job.timestamp < startedAt)
  await Promise.all(stale.map((job) => job.remove().catch(() => undefined)))
  return stale.length
}

/**
 * Close the queue at shutdown. A clean close waits for Redis, which may never
 * come (BullMQ waits for a first connection forever): after a few seconds the
 * connections are dropped instead.
 */
export async function closeRenderQueue(): Promise<void> {
  if (shared === null) return
  const { queue, events, connections } = shared
  shared = null
  await within(
    Promise.allSettled([events.close(), queue.close()]),
    Date.now() + REDIS_CALL_TIMEOUT_MS,
    unavailable('close'),
  ).catch(() => {
    for (const connection of connections) connection.disconnect()
  })
}
