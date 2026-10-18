import { afterEach, describe, expect, it } from 'vitest'
import {
  perfCount,
  perfCountFor,
  perfCountersOn,
  readPerfCounters,
  resetPerfCounters,
  startPerfCounters,
  stopPerfCounters,
} from './perfCounters.js'

afterEach(() => stopPerfCounters())

describe('perfCounters', () => {
  it('counts nothing while off', () => {
    perfCount('a')
    perfCountFor('sg.mount', 'text')
    expect(perfCountersOn()).toBe(false)
    expect(readPerfCounters()).toEqual({})
  })

  it('counts by key once started, with sub-keys and amounts', () => {
    startPerfCounters()
    perfCount('a')
    perfCount('a', 2)
    perfCountFor('sg.mount', 'text')
    perfCountFor('sg.mount', 'text', 3)
    expect(readPerfCounters()).toEqual({ a: 3, 'sg.mount.text': 4 })
  })

  it('keeps counts on a second start, zeroes them on reset, drops them on stop', () => {
    startPerfCounters()
    perfCount('a')
    startPerfCounters()
    expect(readPerfCounters()).toEqual({ a: 1 })
    resetPerfCounters()
    expect(readPerfCounters()).toEqual({})
    expect(perfCountersOn()).toBe(true)
    perfCount('b')
    stopPerfCounters()
    expect(readPerfCounters()).toEqual({})
    resetPerfCounters()
    expect(perfCountersOn()).toBe(false)
  })

  it('hands out copies', () => {
    startPerfCounters()
    perfCount('a')
    const snap = readPerfCounters()
    perfCount('a')
    expect(snap).toEqual({ a: 1 })
  })
})

describe('the counts key', () => {
  it('is the one the web app switches counting on with', async () => {
    const { PERF_COUNTS_KEY } = await import('./perfCounters.js')
    expect(PERF_COUNTS_KEY).toBe('__narrative_perf_counts')
    ;(globalThis as Record<string, unknown>)[PERF_COUNTS_KEY] = {}
    perfCount('x')
    expect(readPerfCounters()).toEqual({ x: 1 })
  })
})
