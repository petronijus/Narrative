import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownerSweepBackoffMs, ownerSweepDelayMs, startOwnerSweeps } from './ownerSweeps.js'
import type { Database } from '../db/client.js'

describe('owner sweep timing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('is due a minute after the grace window', () => {
    vi.stubEnv('MEDIA_SWEEP_GRACE_MS', '')
    expect(ownerSweepDelayMs()).toBe(16 * 60_000)
    vi.stubEnv('MEDIA_SWEEP_GRACE_MS', '0')
    expect(ownerSweepDelayMs()).toBe(60_000)
  })

  it('backs off from 5 minutes, doubling, to 6 hours at most', () => {
    expect([1, 2, 3, 4].map(ownerSweepBackoffMs)).toEqual([5, 10, 20, 40].map((m) => m * 60_000))
    expect(ownerSweepBackoffMs(20)).toBe(6 * 60 * 60_000)
  })

  it('runs one look at a time and stops looking once stopped', async () => {
    vi.useFakeTimers()
    let release: () => void = () => {}
    const execute = vi.fn(
      () =>
        new Promise<{ rows: never[] }>((resolve) => {
          release = () => resolve({ rows: [] })
        }),
    )
    const db = { execute } as unknown as Database
    const runner = startOwnerSweeps(db, { warn() {} }, { firstDelayMs: 10, intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(350)
    // The first look has not finished: no second one meanwhile.
    expect(execute).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(execute).toHaveBeenCalledTimes(2)
    runner.stop()
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
