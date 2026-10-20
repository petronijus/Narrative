/**
 * render/pdfExportQueue.test.ts — the PDF job queue's own logic, on a fake
 * BullMQ: a poller is not left waiting for an end its events connection
 * missed, and the worker lets go of its jobs at once on shutdown and gives a
 * job's slot back however the job ended. The Redis side (the reservation
 * script, a stalled job's retry) is pdfExportQueue.integration.test.ts.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type State = 'waiting' | 'active' | 'completed' | 'failed' | 'unknown'
const jobs = new Map<string, { id: string; data: { userId: string }; state: State }>()
let ready: { promise: Promise<void>; resolve: () => void }
const redisCalls: string[][] = []
let events: FakeEvents
let queue: FakeQueue
let worker: FakeWorker

class FakeEvents extends EventEmitter {
  constructor() {
    super()
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test reaches the instance
    events = this
  }
  waitUntilReady = vi.fn(() => ready.promise)
  close = vi.fn(async () => undefined)
}

class FakeQueue extends EventEmitter {
  constructor() {
    super()
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test reaches the instance
    queue = this
  }
  waitUntilReady = vi.fn(async () => undefined)
  getJob = vi.fn(async (id: string) => {
    const job = jobs.get(id)
    return job === undefined ? undefined : { ...job, getState: async () => jobs.get(id)!.state }
  })
  close = vi.fn(async () => undefined)
}

class FakeWorker extends EventEmitter {
  constructor(
    _name: string,
    readonly processor: unknown,
    readonly opts: Record<string, unknown>,
  ) {
    super()
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test reaches the instance
    worker = this
  }
  close = vi.fn(async (_force?: boolean) => undefined)
}

vi.mock('bullmq', () => ({ Queue: FakeQueue, QueueEvents: FakeEvents, Worker: FakeWorker }))
/** The connections the module opens: only the slot calls are recorded. */
function fakeRedis() {
  return {
    disconnect: vi.fn(),
    multi: () => {
      const calls: string[][] = []
      const chain = {
        zrem: (...args: string[]) => {
          calls.push(['zrem', ...args])
          return chain
        },
        exec: async () => {
          redisCalls.push(...calls)
          return []
        },
      }
      return chain
    },
  }
}
vi.mock('./queue.js', async (original) => ({
  ...(await original<typeof import('./queue.js')>()),
  redisConnection: () => fakeRedis(),
}))

const { bullPdfExportQueue, startPdfExportWorker, PDF_EXPORT_WAIT_POLL_MS } =
  await import('./pdfExportQueue.js')

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

let stop: (() => Promise<void>) | null = null

beforeEach(() => {
  jobs.clear()
  redisCalls.length = 0
  ready = deferred()
})

afterEach(async () => {
  vi.useRealTimers()
  ready.resolve()
  await stop?.()
  stop = null
})

describe('waitForEnd', () => {
  it('reads the state only once the events connection is up, and wakes on a missed end', async () => {
    vi.useFakeTimers()
    jobs.set('pdf_a', { id: 'pdf_a', data: { userId: 'u1' }, state: 'active' })
    let woke = false
    const waited = bullPdfExportQueue.waitForEnd('pdf_a', 20_000).then(() => (woke = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(events.waitUntilReady).toHaveBeenCalled()
    // Not ready yet: no state read that a later event could have overtaken.
    expect(queue.getJob).not.toHaveBeenCalled()
    expect(woke).toBe(false)

    // The job ends while the stream is not read yet: no event ever arrives.
    jobs.get('pdf_a')!.state = 'completed'
    ready.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(woke).toBe(true)
    await waited
  })

  it('wakes from the poll when the end falls between the check and the first read', async () => {
    vi.useFakeTimers()
    ready.resolve()
    jobs.set('pdf_b', { id: 'pdf_b', data: { userId: 'u1' }, state: 'active' })
    let woke = false
    const waited = bullPdfExportQueue.waitForEnd('pdf_b', 20_000).then(() => (woke = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(woke).toBe(false)
    jobs.get('pdf_b')!.state = 'failed' // no 'failed' event reaches this connection
    await vi.advanceTimersByTimeAsync(PDF_EXPORT_WAIT_POLL_MS)
    expect(woke).toBe(true)
    await waited
  })

  it('wakes on the event, and at the timeout at the latest', async () => {
    vi.useFakeTimers()
    ready.resolve()
    jobs.set('pdf_c', { id: 'pdf_c', data: { userId: 'u1' }, state: 'active' })
    let woke = false
    const waited = bullPdfExportQueue.waitForEnd('pdf_c', 20_000).then(() => (woke = true))
    await vi.advanceTimersByTimeAsync(0)
    events.emit('completed', { jobId: 'pdf_c' })
    await vi.advanceTimersByTimeAsync(0)
    expect(woke).toBe(true)
    await waited

    const timedOut = bullPdfExportQueue.waitForEnd('pdf_c2', 5_000)
    jobs.set('pdf_c2', { id: 'pdf_c2', data: { userId: 'u1' }, state: 'waiting' })
    await vi.advanceTimersByTimeAsync(5_000)
    await timedOut
    expect(events.listenerCount('completed')).toBe(0)
  })
})

describe('startPdfExportWorker', () => {
  it('closes with force on stop, so shutdown never waits for a running export', async () => {
    stop = startPdfExportWorker(async () => {
      throw new Error('not run here')
    })
    await stop()
    stop = null
    expect(worker.close).toHaveBeenCalledWith(true)
    expect(worker.opts['maxStalledCount']).toBe(1)
  })

  it('gives the slot back when a job completes, fails, or is failed for stalling', async () => {
    stop = startPdfExportWorker(async () => {
      throw new Error('not run here')
    })
    worker.emit('completed', { id: 'pdf_1', data: { userId: 'u1' } })
    worker.emit('failed', { id: 'pdf_2', data: { userId: 'u2' } }, new Error('x'))
    jobs.set('pdf_3', { id: 'pdf_3', data: { userId: 'u3' }, state: 'failed' })
    events.emit('failed', { jobId: 'pdf_3' })
    await vi.waitFor(() => expect(redisCalls).toHaveLength(6))
    expect(redisCalls).toEqual(
      expect.arrayContaining([
        ['zrem', 'narrative:pdf-export:slots:user:u1', 'pdf_1'],
        ['zrem', 'narrative:pdf-export:slots:all', 'pdf_1'],
        ['zrem', 'narrative:pdf-export:slots:user:u2', 'pdf_2'],
        ['zrem', 'narrative:pdf-export:slots:user:u3', 'pdf_3'],
        ['zrem', 'narrative:pdf-export:slots:all', 'pdf_3'],
      ]),
    )
  })
})
