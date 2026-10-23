import { describe, expect, it } from 'vitest'
import type { BenchDef } from './defineBench.js'
import {
  classifySocketClose,
  describeSocketClose,
  DisturbanceLog,
  DisturbedRunError,
  formatDiscards,
  guarded,
  isNetworkChangeError,
  retryVerdict,
  socketCloseDisturbs,
  touching,
  type DiscardedRun,
  type Disturbance,
  type FailedAttemptMarker,
  type RunGuard,
} from './disturbance.js'
import type { Fingerprint } from './fingerprint.js'
import { runBench, runInterleaved } from './result.js'

const FP: Fingerprint = {
  machine: 'm',
  git: null,
  build: { mode: 'prod', source: { kind: 'local' } },
  os: { platform: 'darwin', release: '27', arch: 'arm64' },
  cpu: { model: 'cpu', cores: 8 },
  loadAvg: [0, 0, 0],
  node: 'v24',
  power: null,
  takenAt: '2026-10-23T00:00:00.000Z',
}

const ms = { unit: 'ms', better: 'lower', kind: 'time' } as const
const rasters = { unit: 'count', better: 'lower', kind: 'work' } as const

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
}

describe('isNetworkChangeError', () => {
  it('knows the error texts of a network that changed or went away', () => {
    for (const text of [
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NETWORK_IO_SUSPENDED',
      'The network connection was lost.',
      'The Internet connection appears to be offline.',
    ])
      expect(isNetworkChangeError(text), text).toBe(true)
  })

  it('leaves the page cancelling, the server failing and the rest alone', () => {
    for (const text of [
      'net::ERR_ABORTED',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_EMPTY_RESPONSE',
      'net::ERR_FAILED',
      'cancelled',
      '',
    ])
      expect(isNetworkChangeError(text), text).toBe(false)
    expect(isNetworkChangeError(null)).toBe(false)
    expect(isNetworkChangeError(undefined)).toBe(false)
  })

  it('without offline, takes only a change — what a spec cannot do on purpose', () => {
    const strict = { offline: false }
    expect(isNetworkChangeError('net::ERR_NETWORK_CHANGED', strict)).toBe(true)
    expect(isNetworkChangeError('The network connection was lost.', strict)).toBe(true)
    // setOffline and route.abort('internetdisconnected') — the specs' own doing.
    expect(isNetworkChangeError('net::ERR_INTERNET_DISCONNECTED', strict)).toBe(false)
    expect(isNetworkChangeError('The Internet connection appears to be offline.', strict)).toBe(
      false,
    )
  })
})

describe('touching', () => {
  const ev = (at: number): Disturbance => ({ at, source: 'host', detail: `at ${at}` })
  it('takes the window with its margins, inclusive', () => {
    const events = [ev(0), ev(6999), ev(7000), ev(12000), ev(12500), ev(12501)]
    expect(
      touching(events, 10000, 12000, { beforeMs: 3000, afterMs: 500 }).map((e) => e.at),
    ).toEqual([7000, 12000, 12500])
  })
})

describe('DisturbanceLog', () => {
  it('keeps events in time order, whoever reports them late', () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    log.record('browser', 'b', 300)
    log.record('host', 'h', 100)
    log.record('browser', 'b2', 200)
    expect(log.all().map((e) => e.at)).toEqual([100, 200, 300])
    log.prune(150)
    expect(log.all().map((e) => e.at)).toEqual([200, 300])
  })

  it('tells subscribers, and how long it has been quiet', () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const seen: string[] = []
    const off = log.subscribe((d) => seen.push(d.detail))
    expect(log.quietFor()).toBe(Infinity)
    log.record('host', 'one')
    c.advance(250)
    expect(log.quietFor()).toBe(250)
    off()
    log.record('host', 'two')
    expect(seen).toEqual(['one'])
  })

  it('waits until the network has been quiet long enough, or gives up', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    log.record('host', 'flap')
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      c.advance(ms)
      // A second flap while we wait: the quiet period starts again.
      if (sleeps.length === 1) log.record('host', 'flap again')
    }
    expect(await log.waitQuiet(2000, 60_000, sleep)).toBe(true)
    expect(sleeps).toEqual([2000, 2000])

    const never = new DisturbanceLog(c.now)
    never.record('host', 'flap')
    const flapping = async (ms: number) => {
      c.advance(ms)
      never.record('host', 'and again')
    }
    expect(await never.waitQuiet(2000, 5000, flapping)).toBe(false)
  })
})

/** A guard over a log: a run is disturbed when an event touches it (no margins: the test places events exactly). */
function guardOver(
  log: DisturbanceLog,
  c: ReturnType<typeof clock>,
  extra: Partial<RunGuard> = {},
): RunGuard {
  return {
    disturbances: (start, end) => log.touching(start, end, { beforeMs: 0, afterMs: 0 }),
    now: c.now,
    ...extra,
  }
}

describe('guarded', () => {
  it('returns an undisturbed run as it is, and rethrows its own error', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const discarded: DiscardedRun[] = []
    const slot = { phase: 'run' as const, index: 1 }
    expect(await guarded('b', async () => 42, guardOver(log, c), slot, discarded)).toBe(42)
    await expect(
      guarded(
        'b',
        async () => {
          throw new Error('a real failure')
        },
        guardOver(log, c),
        slot,
        discarded,
      ),
    ).rejects.toThrow('a real failure')
    expect(discarded).toEqual([])
  })

  it('discards a disturbed attempt — returned or thrown — recovers and runs it again', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const discarded: DiscardedRun[] = []
    const recovered: number[] = []
    let attempt = 0
    const value = await guarded(
      'transform.nudge.rect',
      async () => {
        attempt++
        c.advance(100)
        if (attempt === 1) log.record('browser', 'net::ERR_NETWORK_CHANGED GET /api/x')
        if (attempt === 2) {
          log.record('host', 'en14 gone (172.16.42.2)')
          c.advance(100)
          throw new Error('page.evaluate: Target closed\nmore lines')
        }
        c.advance(100)
        return attempt
      },
      guardOver(log, c, { recover: async (seen) => void recovered.push(seen.length) }),
      { side: 'prod', phase: 'run', index: 4 },
      discarded,
    )
    expect(value).toBe(3)
    expect(recovered).toEqual([1, 1])
    expect(discarded.map((d) => [d.side, d.phase, d.index, d.attempt, d.error])).toEqual([
      ['prod', 'run', 4, 1, undefined],
      ['prod', 'run', 4, 2, 'page.evaluate: Target closed'],
    ])
    expect(discarded[0]!.disturbances).toEqual([
      {
        at: new Date(1_000_100).toISOString(),
        source: 'browser',
        detail: 'net::ERR_NETWORK_CHANGED GET /api/x',
      },
    ])
  })

  it('fails loudly once a run stays disturbed past its retries', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const discarded: DiscardedRun[] = []
    let attempts = 0
    const run = guarded(
      'transform.nudge.rect',
      async () => {
        attempts++
        c.advance(10)
        log.record('host', 'en14 up (172.16.42.2)')
        return 1
      },
      guardOver(log, c, { retries: 3 }),
      { phase: 'run', index: 2 },
      discarded,
    )
    await expect(run).rejects.toBeInstanceOf(DisturbedRunError)
    await expect(run).rejects.toThrow(/run 2 was disturbed in 4 attempts in a row/)
    expect(attempts).toBe(4)
    expect(discarded).toHaveLength(4)
  })

  it('runs the run once, unguarded, without a guard', async () => {
    let n = 0
    expect(await guarded('b', async () => ++n, undefined, { phase: 'run', index: 1 }, [])).toBe(1)
  })
})

describe('runInterleaved / runBench with a guard', () => {
  function bench(run: BenchDef<string>['run']): BenchDef<string> {
    return {
      id: 'transform.nudge.rect',
      area: 'transform',
      layer: 'I',
      run,
      metrics: { ms, rasters },
    }
  }

  it('keeps only undisturbed samples, records the discards per side, keeps A B A B', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const order: string[] = []
    let calls = 0
    const def = bench((side) => {
      calls++
      order.push(side)
      c.advance(25)
      // The 4th call (B's first recorded run) is disturbed mid-run; its rerun is clean.
      if (calls === 4) log.record('browser', 'net::ERR_NETWORK_CHANGED')
      c.advance(25)
      return { ms: calls === 4 ? 999 : 10, rasters: 3 }
    })
    const notes: DiscardedRun[] = []
    const [a, b] = await runInterleaved(
      def,
      [
        { name: 'A', ctx: 'A', fingerprint: FP },
        { name: 'B', ctx: 'B', fingerprint: FP },
      ],
      { warmup: 1, runs: 2, guard: guardOver(log, c, { onDiscard: (d) => notes.push(d) }) },
    )
    expect(order).toEqual(['A', 'B', 'A', 'B', 'B', 'A', 'B'])
    // The disturbed 999 never reaches the samples.
    expect(b!.samples['ms']).toEqual([10, 10])
    expect(b!.counters).toEqual({ rasters: 3 })
    expect(b!.discarded?.map((d) => [d.side, d.phase, d.index, d.attempt])).toEqual([
      ['B', 'run', 1, 1],
    ])
    expect(a!.discarded).toBeUndefined()
    expect(notes).toHaveLength(1)
    expect(formatDiscards('transform.nudge.rect', b!.discarded!)).toBe(
      'PERF note transform.nudge.rect: 1 sample discarded and re-run (a network change or a dropped connection, seen by: browser)',
    )
  })

  it('reruns a disturbed warm-up as a warm-up', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    let calls = 0
    const def = bench(() => {
      calls++
      c.advance(25)
      if (calls === 1) log.record('host', 'en14 gone (172.16.42.2)')
      c.advance(25)
      return { ms: 10, rasters: 3 }
    })
    const r = await runBench(def, 'A', FP, { warmup: 2, runs: 2, guard: guardOver(log, c) })
    expect(calls).toBe(5)
    expect(r.samples['ms']).toEqual([10, 10])
    expect(r.discarded?.map((d) => [d.phase, d.index, d.attempt])).toEqual([['warmup', 1, 1]])
    expect(formatDiscards(def.id, r.discarded!)).toBe(
      'PERF note transform.nudge.rect: 0 samples discarded and re-run, 1 warm-up run too (a network change or a dropped connection, seen by: host)',
    )
  })

  it('stores nothing — throws — when a run cannot get an undisturbed attempt', async () => {
    const c = clock()
    const log = new DisturbanceLog(c.now)
    const def = bench(() => {
      c.advance(50)
      log.record('host', 'en14 flapping')
      return { ms: 10, rasters: 3 }
    })
    await expect(
      runInterleaved(def, [{ name: 'A', ctx: 'A', fingerprint: FP }], {
        warmup: 0,
        runs: 3,
        guard: guardOver(log, c, { retries: 2 }),
      }),
    ).rejects.toBeInstanceOf(DisturbedRunError)
  })

  it('leaves a result without a guard exactly as before (no discarded field)', async () => {
    const r = await runBench(
      bench(() => ({ ms: 1, rasters: 1 })),
      'A',
      FP,
      { warmup: 0, runs: 2 },
    )
    expect('discarded' in r).toBe(false)
  })
})

describe('retryVerdict', () => {
  const marker = (disturbances: FailedAttemptMarker['disturbances']): FailedAttemptMarker => ({
    testId: 't',
    retry: 0,
    status: 'failed',
    start: '2026-10-23T10:00:00.000Z',
    end: '2026-10-23T10:00:20.000Z',
    disturbances,
  })

  it('always runs a first attempt', () => {
    expect(retryVerdict(0, null).run).toBe(true)
  })

  it('retries only a failure that coincided with a network change', () => {
    const v = retryVerdict(
      1,
      marker([
        { at: '2026-10-23T10:00:05.000Z', source: 'browser', detail: 'net::ERR_NETWORK_CHANGED' },
      ]),
    )
    expect(v.run).toBe(true)
    expect(v.because).toMatch(/failed across a network change.*ERR_NETWORK_CHANGED/)
  })

  it('never retries a failure without one, nor one nobody judged', () => {
    expect(retryVerdict(1, marker([]))).toEqual({
      run: false,
      because: 'attempt 1 failed without a network change: not retried (its error is the real one)',
    })
    expect(retryVerdict(1, null).run).toBe(false)
  })
})

describe('socket closes', () => {
  const url = 'ws://localhost:62620/ws'
  const at = 50_000

  it('takes the page closing a socket as orderly, whatever the code — even one still connecting', () => {
    expect(classifySocketClose({ at, url, code: 1005, wasClean: true, byPage: true })).toBe(
      'orderly',
    )
    // close() before the handshake finished: the event says 1006, not clean.
    expect(classifySocketClose({ at, url, code: 1006, wasClean: false, byPage: true })).toBe(
      'orderly',
    )
  })

  it('takes a close frame from the other end as orderly', () => {
    for (const code of [1000, 1001, 1011, 4404])
      expect(
        classifySocketClose({ at, url, code, wasClean: true, byPage: false }),
        String(code),
      ).toBe('orderly')
  })

  it('takes a connection dropped under the page as abnormal', () => {
    expect(classifySocketClose({ at, url, code: 1006, wasClean: false, byPage: false })).toBe(
      'abnormal',
    )
    expect(classifySocketClose({ at, url, code: 1000, wasClean: false })).toBe('abnormal')
    expect(classifySocketClose({ at, url })).toBe('unknown')
  })

  it('counts a close as a disturbance only when the network explains it', () => {
    const host: Disturbance = { at: at - 1000, source: 'host', detail: 'en14 gone (172.16.42.2)' }
    const otherClose: Disturbance = {
      at: at - 500,
      source: 'browser',
      detail: 'WebSocket closed abnormally (1006, not clean): ws://localhost:3002/',
    }
    // present.jump.link on 2026-10-23: the page closed its slide documents' sockets, nothing else.
    expect(socketCloseDisturbs({ at, url, code: 1005, wasClean: true, byPage: true }, [host])).toBe(
      false,
    )
    expect(socketCloseDisturbs({ at, url, code: 1000, wasClean: true }, [host])).toBe(false)
    expect(socketCloseDisturbs({ at, url, code: 1006, wasClean: false }, [])).toBe(true)
    // No close code reported: only a network signal near it makes it one — another socket's close does not.
    expect(socketCloseDisturbs({ at, url }, [])).toBe(false)
    expect(socketCloseDisturbs({ at, url }, [otherClose])).toBe(false)
    expect(socketCloseDisturbs({ at, url }, [host])).toBe(true)
    expect(socketCloseDisturbs({ at, url }, [{ ...host, at: at - 10_000 }])).toBe(false)
  })

  it('says what it saw', () => {
    expect(describeSocketClose({ at, url, code: 1006, wasClean: false })).toBe(
      'WebSocket closed abnormally (1006, not clean): ws://localhost:62620/ws',
    )
  })
})
