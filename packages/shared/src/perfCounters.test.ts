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
    expect(PERF_COUNTS_KEY).toBe(Symbol.for('narrative.perf.counts'))
    ;(globalThis as Record<symbol, unknown>)[PERF_COUNTS_KEY] = {}
    perfCount('x')
    expect(readPerfCounters()).toEqual({ x: 1 })
  })

  it('cannot be shadowed by a page element reached through named access', () => {
    // `<div id="__narrative_perf_counts">` makes `window.__narrative_perf_counts`
    // that element (named access); the old string key would have read it as
    // "counting on" and written expandos onto it. Modelled on the prototype,
    // where browsers put named properties.
    const element = { tagName: 'DIV' }
    const proto = Object.getPrototypeOf(globalThis) as Record<string, unknown>
    const names = ['__narrative_perf_counts', 'narrative.perf.counts']
    for (const name of names)
      Object.defineProperty(proto, name, { value: element, configurable: true })
    try {
      expect(perfCountersOn()).toBe(false)
      perfCount('x')
      perfCountFor('sg.mount', 'text')
      expect(readPerfCounters()).toEqual({})
      expect(element).toEqual({ tagName: 'DIV' })
    } finally {
      for (const name of names) delete proto[name]
    }
  })
})
