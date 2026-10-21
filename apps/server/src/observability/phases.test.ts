/**
 * observability/phases.test.ts — the per-request phase clock: who may ask
 * for phases (the keyed policy), off unless asked, isolated between
 * concurrent requests, nothing reported before authorisation or on a
 * refusal, names and durations checked on the way out, and the wire format.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_REPORTED_PHASES,
  PhaseClock,
  currentClock,
  parseServerTiming,
  phaseEnd,
  phaseLap,
  phaseStart,
  reportablePhases,
  runTimed,
  serverTimingHeader,
  timingPolicy,
  wantsTiming,
} from './phases.js'

const KEY = 'k3y-for-the-perf-probe-0123456789'

describe('timingPolicy', () => {
  it('is dev outside production, off in production, keyed with SERVER_TIMING_KEY', () => {
    expect(timingPolicy({}).mode).toBe('dev')
    expect(timingPolicy({ NODE_ENV: 'production' }).mode).toBe('off')
    // SERVER_TIMING=true alone no longer opens production.
    expect(timingPolicy({ NODE_ENV: 'production', SERVER_TIMING: 'true' }).mode).toBe('off')
    expect(timingPolicy({ NODE_ENV: 'production', SERVER_TIMING_KEY: KEY }).mode).toBe('key')
    expect(timingPolicy({ SERVER_TIMING_KEY: KEY }).mode).toBe('key')
    expect(timingPolicy({ SERVER_TIMING: 'false', SERVER_TIMING_KEY: KEY }).mode).toBe('off')
  })

  it('refuses a key too short to be one', () => {
    expect(() => timingPolicy({ SERVER_TIMING_KEY: 'short' })).toThrow(/at least 16/)
  })
})

describe('wantsTiming', () => {
  const dev = timingPolicy({})
  const keyed = timingPolicy({ SERVER_TIMING_KEY: KEY })
  const off = timingPolicy({ NODE_ENV: 'production' })

  it('in dev needs the header set to 1', () => {
    expect(wantsTiming({ 'x-narrative-timing': '1' }, dev)).toBe(true)
    expect(wantsTiming({ 'x-narrative-timing': 'yes' }, dev)).toBe(false)
    expect(wantsTiming({}, dev)).toBe(false)
    expect(wantsTiming({ 'x-narrative-timing': '1' }, off)).toBe(false)
  })

  it('with a key needs exactly the key: not 1, not a prefix, not a longer value', () => {
    expect(wantsTiming({ 'x-narrative-timing': KEY }, keyed)).toBe(true)
    for (const value of ['1', KEY.slice(0, -1), `${KEY}x`, '', KEY.toUpperCase()])
      expect(wantsTiming({ 'x-narrative-timing': value }, keyed), value).toBe(false)
    expect(wantsTiming({ 'x-narrative-timing': [KEY, KEY] }, keyed)).toBe(false)
  })
})

describe('marks', () => {
  it('record nothing outside a timed request', () => {
    expect(currentClock()).toBeUndefined()
    expect(phaseStart()).toBe(-1)
    // After a timed request ran, untimed code still records nothing.
    runTimed(new PhaseClock(), () => undefined)
    expect(phaseStart()).toBe(-1)
    phaseEnd('host.admit', -1)
    phaseLap('host')
    expect(currentClock()).toBeUndefined()
  })

  it('record spans and laps of the current request only, across awaits', async () => {
    const a = new PhaseClock()
    const b = new PhaseClock()
    const work = async (clock: PhaseClock, ms: number): Promise<void> =>
      runTimed(clock, async () => {
        const t = phaseStart()
        await new Promise((r) => setTimeout(r, ms))
        phaseEnd('host.load', t)
        phaseLap('host')
      })
    await Promise.all([work(a, 20), work(b, 1)])
    const ja = a.toJSON()
    const jb = b.toJSON()
    expect(ja['host.load']).toBeGreaterThanOrEqual(15)
    expect(jb['host.load']).toBeLessThan(ja['host.load']!)
    expect(Object.keys(ja)).toEqual(['host.load', 'host'])
    // Outside both runs again.
    expect(currentClock()).toBeUndefined()
  })

  it('sum spans of one name', () => {
    const c = new PhaseClock(0)
    c.add('host.audit', 1.5)
    c.add('host.audit', 2)
    c.lap('http.pre', 10)
    c.lap('host', 12.5)
    expect(c.toJSON()).toEqual({ 'host.audit': 3.5, 'http.pre': 10, host: 2.5 })
  })
})

describe('what may be reported', () => {
  it('nothing before the call was authorised on its target, nor on a 401, 403 or 429', () => {
    const c = new PhaseClock(0)
    c.lap('http.pre', 2)
    expect(reportablePhases(c)).toBeNull()
    expect(reportablePhases(null)).toBeNull()
    c.authorise()
    expect(reportablePhases(c, 200)).toEqual({ 'http.pre': 2 })
    expect(reportablePhases(c, 404)).toEqual({ 'http.pre': 2 })
    for (const status of [401, 403, 429]) expect(reportablePhases(c, status)).toBeNull()
  })

  it('only plain dotted names and finite non-negative durations, at most MAX_REPORTED_PHASES', () => {
    const c = new PhaseClock(0)
    c.add('render.page.ready', 5)
    for (const name of [
      'render.page.a;dur=0, evil',
      'Render',
      'render page',
      '',
      `a${'b'.repeat(64)}`,
    ])
      c.add(name, 1)
    c.add('render.page.nan', Number.NaN)
    c.add('render.page.neg', -1)
    c.add('render.page.inf', Number.POSITIVE_INFINITY)
    expect(c.toJSON()).toEqual({ 'render.page.ready': 5 })
    const many = new PhaseClock(0)
    for (let i = 0; i < MAX_REPORTED_PHASES + 10; i++) many.add(`p${i}`, i)
    expect(Object.keys(many.toJSON())).toHaveLength(MAX_REPORTED_PHASES)
  })
})

describe('Server-Timing', () => {
  it('round-trips through the header', () => {
    const header = serverTimingHeader({ 'http.pre': 0.25, 'host.validate': 1.125 })
    expect(header).toBe('http.pre;dur=0.250, host.validate;dur=1.125')
    expect(parseServerTiming(header)).toEqual({ 'http.pre': 0.25, 'host.validate': 1.125 })
    expect(parseServerTiming(null)).toEqual({})
  })

  it('checks names and durations again', () => {
    expect(serverTimingHeader({ 'a;b, c': 1, ok: 2, bad: Number.NaN, neg: -3 })).toBe(
      'ok;dur=2.000',
    )
  })
})
