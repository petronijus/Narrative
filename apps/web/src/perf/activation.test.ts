import { PERF_COUNTS_KEY, perfCountersOn, stopPerfCounters } from '@narrative/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { COUNTS_KEY, bootPerf, perfAvailable, whenPerfHarnessReady } from './activation'

afterEach(() => stopPerfCounters())

describe('perf activation', () => {
  it('switches on the counters of @narrative/shared through the same key', () => {
    expect(COUNTS_KEY).toBe(PERF_COUNTS_KEY)
  })

  it('counts in dev without ?perf=1, and never waits for a harness nobody asked for', async () => {
    expect(perfAvailable()).toBe(import.meta.env.DEV)
    bootPerf()
    expect(perfCountersOn()).toBe(import.meta.env.DEV)
    await expect(whenPerfHarnessReady()).resolves.toBeUndefined()
  })
})
