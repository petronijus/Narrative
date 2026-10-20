import { PERF_COUNTS_KEY, perfCountersOn, stopPerfCounters } from '@narrative/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { COUNTS_KEY, bootPerf, perfAvailable, whenPerfHarnessReady } from './activation'

afterEach(() => stopPerfCounters())

describe('perf activation', () => {
  it('switches on the counters of @narrative/shared through the same key', () => {
    expect(COUNTS_KEY).toBe(PERF_COUNTS_KEY)
    // A symbol: no element id or name can shadow it through named access.
    expect(typeof COUNTS_KEY).toBe('symbol')
  })

  it('is not switched on by an element named like the old string key', () => {
    const div = document.createElement('div')
    div.id = '__narrative_perf_counts'
    document.body.append(div)
    try {
      expect(perfCountersOn()).toBe(false)
    } finally {
      div.remove()
    }
  })

  it('counts in dev without ?perf=1, and never waits for a harness nobody asked for', async () => {
    expect(perfAvailable()).toBe(import.meta.env.DEV)
    bootPerf()
    expect(perfCountersOn()).toBe(import.meta.env.DEV)
    await expect(whenPerfHarnessReady()).resolves.toBeUndefined()
  })
})
