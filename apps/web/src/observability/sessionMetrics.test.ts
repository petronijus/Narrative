/**
 * observability/sessionMetrics.test.ts — the session report (G4): which
 * pages report, the sampling draw, the report built from long tasks, event
 * timing and the deck's load timings, cold vs warm, and one send per
 * session. The browser APIs are a fake env; the schema check is the
 * server's own (@narrative/shared clientMetricsReportSchema).
 */

import { describe, expect, it } from 'vitest'
import { clientMetricsReportSchema, type ClientMetricsReport } from '@narrative/shared'
import type { LoadTimings } from '../state/loadTimings.js'
import {
  estimateInp,
  longTaskTimeWithin,
  randomUuid,
  routeKind,
  startSessionMetrics,
  type SessionMetricsEnv,
} from './sessionMetrics.js'

type Observer = (entries: readonly PerformanceEntry[]) => void

function fakeEnv(over: Partial<SessionMetricsEnv> = {}) {
  let clock = 0
  let timings: LoadTimings | null = null
  const observers: Partial<Record<'longtask' | 'event', Observer>> = {}
  const intervals: (() => void)[] = []
  const sent: ClientMetricsReport[] = []
  let hide: (() => void) | null = null
  const env: SessionMetricsEnv = {
    pathname: '/deck/abc',
    hasShareToken: false,
    webdriver: false,
    sampleRate: 1,
    random: () => 0.5,
    now: () => clock,
    observe: (type, fn) => {
      observers[type] = fn
      return () => delete observers[type]
    },
    navigation: () => ({ ttfbMs: 110.4, fcpMs: 612.6, domContentLoadedMs: 700 }),
    interactionCount: () => null,
    reportId: () => '6f1c1a3e-2b7d-4c7e-9a51-0d3b8f2e4a10',
    readLoadTimings: () => timings,
    onFirstHide: (fn) => {
      hide = fn
      return () => (hide = null)
    },
    setInterval: (fn) => {
      intervals.push(fn)
      return () => intervals.splice(intervals.indexOf(fn), 1)
    },
    send: (r) => sent.push(r),
    ...over,
  }
  return {
    env,
    sent,
    tick: (ms: number) => {
      clock += ms
      for (const fn of [...intervals]) fn()
    },
    setTimings: (t: Partial<LoadTimings> & { start: number }) => {
      timings = {
        wsConnectedMs: null,
        wsSyncedMs: null,
        pixiReadyMs: null,
        firstPaintMs: null,
        ...t,
      }
    },
    longTask: (start: number, duration: number) =>
      observers.longtask?.([{ startTime: start, duration } as PerformanceEntry]),
    event: (interactionId: number, duration: number) =>
      observers.event?.([{ interactionId, duration } as unknown as PerformanceEntry]),
    hide: () => hide?.(),
    observing: () => Object.keys(observers),
    intervals: () => intervals.length,
  }
}

describe('routeKind', () => {
  it.each([
    ['/deck/abc', 'editor'],
    ['/deck/abc/', 'editor'],
    ['/deck/abc/present', 'present'],
    ['/', 'home'],
    ['/folder/f1', 'home'],
    ['/folder/f1/settings', 'other'],
    ['/settings/access-tokens', 'other'],
    ['/folder/f1/component/c1', 'other'],
    ['/deck/abc/render', null],
    ['/folder/f1/component/c1/render', null],
    ['/auth/login', null],
  ])('%s → %s', (path, kind) => {
    expect(routeKind(path)).toBe(kind)
  })
})

describe('estimateInp', () => {
  it('is the worst interaction below 50, the (n/50)-th worst above', () => {
    expect(estimateInp([], 0)).toBeNull()
    expect(estimateInp([40, 300, 120], 3)).toBe(300)
    const durations = Array.from({ length: 120 }, (_, i) => i + 1) // 1..120
    // 120 interactions → index 2 of the descending list: 118.
    expect(estimateInp(durations, 120)).toBe(118)
    // More interactions than entries above the threshold: the index is clamped.
    expect(estimateInp([90, 60], 400)).toBe(60)
  })
})

describe('randomUuid', () => {
  it('is a v4 UUID the schema takes, also without crypto.randomUUID', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(randomUuid()).toMatch(uuid)
    const original = crypto.randomUUID
    try {
      Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
      const ids = new Set(Array.from({ length: 50 }, () => randomUuid()))
      expect(ids.size).toBe(50)
      for (const id of ids) expect(id).toMatch(uuid)
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true })
    }
  })
})

describe('longTaskTimeWithin', () => {
  it('clips each task to the window', () => {
    const tasks = [
      { start: 0, duration: 100 }, // 50 inside
      { start: 200, duration: 80 }, // all inside
      { start: 950, duration: 200 }, // 50 inside
      { start: 2000, duration: 60 }, // outside
    ]
    expect(longTaskTimeWithin(tasks, 50, 1000)).toBe(180)
  })
})

describe('startSessionMetrics', () => {
  it('does not report automated browsers, share links, render pages or an unsampled session', () => {
    expect(startSessionMetrics(fakeEnv({ webdriver: true }).env)).toBeNull()
    expect(startSessionMetrics(fakeEnv({ hasShareToken: true }).env)).toBeNull()
    expect(startSessionMetrics(fakeEnv({ pathname: '/deck/abc/render' }).env)).toBeNull()
    expect(startSessionMetrics(fakeEnv({ sampleRate: 0.4, random: () => 0.4 }).env)).toBeNull()
    expect(startSessionMetrics(fakeEnv({ sampleRate: 0 }).env)).toBeNull()
    expect(startSessionMetrics(fakeEnv({ sampleRate: 0.4, random: () => 0.39 }).env)).not.toBeNull()
  })

  it('reports the cold open of the landing deck once, on the first hide', () => {
    const f = fakeEnv()
    startSessionMetrics(f.env)
    f.tick(250)
    f.setTimings({
      start: 300,
      wsConnectedMs: 150,
      wsSyncedMs: 410,
      pixiReadyMs: 380,
      firstPaintMs: 900,
    })
    f.tick(250)
    expect(f.intervals()).toBe(0) // the landing deck was found: no more polling

    f.longTask(100, 80) // before the deck route mounted
    f.longTask(500, 120) // during the load
    f.longTask(1150, 100) // half inside (the paint is at 300 + 900 = 1200)
    f.longTask(5000, 400) // later in the session
    f.event(1, 24)
    f.event(1, 88) // the same interaction's longest entry counts
    f.event(2, 200)
    f.event(0, 999) // not an interaction

    f.hide()
    f.hide()
    expect(f.sent).toHaveLength(1)
    const r = f.sent[0]!
    expect(clientMetricsReportSchema.safeParse(r).success).toBe(true)
    expect(r).toEqual({
      v: 1,
      id: '6f1c1a3e-2b7d-4c7e-9a51-0d3b8f2e4a10',
      route: 'editor',
      nav: { ttfbMs: 110, fcpMs: 613, domContentLoadedMs: 700 },
      deckLoad: {
        cold: true,
        wsConnectedMs: 150,
        wsSyncedMs: 410,
        pixiReadyMs: 380,
        firstPaintMs: 900,
        longTaskMs: 170,
      },
      longTasks: { count: 4, totalMs: 700, maxMs: 400 },
      inp: { interactions: 2, inpMs: 200 },
    })
    expect(f.observing()).toEqual([]) // observers disconnected after the report
  })

  it('calls a later deck of the same page warm', () => {
    const f = fakeEnv()
    const m = startSessionMetrics(f.env)!
    f.setTimings({ start: 300, firstPaintMs: 900 })
    f.tick(250)
    f.setTimings({ start: 20_000, wsSyncedMs: 90, firstPaintMs: 140 })
    expect(m.report().deckLoad).toMatchObject({ cold: false, wsSyncedMs: 90, firstPaintMs: 140 })
  })

  it('reports a page that opened no deck, and a deck that has not painted yet', () => {
    const home = fakeEnv({ pathname: '/' })
    const h = startSessionMetrics(home.env)!
    expect(home.intervals()).toBe(0) // no deck to look for
    expect(h.report()).toMatchObject({ route: 'home', deckLoad: null })

    const f = fakeEnv()
    const m = startSessionMetrics(f.env)!
    f.setTimings({ start: 100, wsConnectedMs: 50 })
    f.tick(2000)
    f.longTask(1500, 300)
    const r = m.report()
    expect(r.deckLoad).toMatchObject({ firstPaintMs: null, longTaskMs: 300 })
    expect(clientMetricsReportSchema.safeParse(r).success).toBe(true)
  })

  it('stops looking for the landing deck after its window, and uses interactionCount', () => {
    const f = fakeEnv({ interactionCount: () => 60 })
    const m = startSessionMetrics(f.env)!
    for (let i = 0; i < 130; i++) f.tick(250)
    expect(f.intervals()).toBe(0)
    f.setTimings({ start: 40_000, firstPaintMs: 500 })
    f.event(1, 300)
    f.event(2, 100)
    const r = m.report()
    expect(r.deckLoad?.cold).toBe(false)
    // 60 interactions → the 2nd longest (index 1).
    expect(r.inp).toEqual({ interactions: 60, inpMs: 100 })
  })

  it('keeps every number inside the schema bounds', () => {
    const f = fakeEnv({ navigation: () => ({ ttfbMs: -3, fcpMs: 9e9, domContentLoadedMs: NaN }) })
    const m = startSessionMetrics(f.env)!
    f.longTask(0, 700_000)
    const r = m.report()
    expect(r.nav).toEqual({ ttfbMs: 0, fcpMs: 600_000, domContentLoadedMs: null })
    expect(r.longTasks.maxMs).toBe(600_000)
    expect(clientMetricsReportSchema.safeParse(r).success).toBe(true)
  })

  it('works where the browser observes neither entry type', () => {
    const f = fakeEnv({ observe: () => null })
    const m = startSessionMetrics(f.env)!
    expect(m.report()).toMatchObject({
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      inp: { interactions: 0, inpMs: null },
    })
  })
})
