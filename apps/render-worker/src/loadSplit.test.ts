import { describe, expect, it } from 'vitest'
import { formatLoadSplit, loadSplit, loadSplitSteps, type LoadSnapshot } from './loadSplit.js'

const snapshot = (over: Partial<LoadSnapshot> = {}): LoadSnapshot => ({
  now: 1400,
  htmlEnd: 40,
  resources: [
    { kind: 'script', start: 45, end: 300 },
    { kind: 'script', start: 50, end: 420 },
    { kind: 'auth', start: 430, end: 470 },
    { kind: 'style', start: 45, end: 90 },
    // Loaded after the shell mounted: a later chunk, not on the boot path.
    { kind: 'script', start: 700, end: 900 },
    { kind: 'api', start: 520, end: 600 },
  ],
  shellStart: 500,
  wsSyncedMs: 650,
  pixiReadyMs: 380,
  ...over,
})

describe('loadSplit', () => {
  it('splits the load into its critical path, from navigation start to the hooks', () => {
    expect(loadSplit(snapshot())).toEqual({
      html: 40,
      scripts: 380,
      boot: 80,
      pixi: 380,
      inputs: 900,
      auth: 470,
      synced: 1150,
      total: 1400,
      scriptCount: 2,
    })
  })

  it('has nothing to split when the deck shell never mounted', () => {
    expect(loadSplit(snapshot({ shellStart: null }))).toBeNull()
  })

  it('keeps every phase non-negative when the clocks overlap', () => {
    // A script that ends after the shell mounted (it started before) and no
    // navigation entry: the phases still add up to the shell's mount.
    const split = loadSplit(
      snapshot({ htmlEnd: null, resources: [{ kind: 'script', start: 10, end: 650 }] }),
    )!
    expect(split).toMatchObject({ html: 0, scripts: 500, boot: 0, auth: null, scriptCount: 1 })
    expect(split.html + split.scripts + split.boot).toBe(500)
  })

  it('reports the phases as worker steps the server accepts, and in one log line', () => {
    const split = loadSplit(snapshot())!
    const steps = loadSplitSteps(split)
    expect(steps.map(([name]) => name)).toEqual([
      'worker.load.html',
      'worker.load.scripts',
      'worker.load.boot',
      'worker.load.inputs',
      'worker.load.pixi',
    ])
    // apps/server/src/render/jobTimings.ts WORKER_STEP
    for (const [name] of steps) expect(name).toMatch(/^(worker|page)\.[a-z][a-z0-9.]{0,40}$/)
    expect(formatLoadSplit(split)).toBe(
      'html 40, scripts 380 (2), boot 80, inputs 900, pixi 380, auth@470, synced@1150, total 1400',
    )
  })
})

describe('loadSplit on what a page answered', () => {
  it('takes no reading that is not a clock, and no resource of unknown kind', () => {
    const split = loadSplit({
      ...snapshot(),
      htmlEnd: Number.NaN,
      pixiReadyMs: -5,
      wsSyncedMs: 'soon',
      resources: [
        { kind: 'script', start: 45, end: 420 },
        { kind: 'script', start: 50, end: Number.POSITIVE_INFINITY },
        { kind: 'evil', start: 10, end: 499 },
        { kind: 'auth', start: 430, end: 1e12 },
        null,
        'script',
      ],
    })
    expect(split).toMatchObject({
      html: 0,
      scripts: 420,
      boot: 80,
      pixi: null,
      synced: null,
      auth: null,
      scriptCount: 1,
    })
  })

  it('splits nothing from an answer that is no snapshot', () => {
    expect(loadSplit(null)).toBeNull()
    expect(loadSplit('loaded')).toBeNull()
    expect(loadSplit({ ...snapshot(), now: 1e12 })).toBeNull()
  })

  it('reads at most the first 2000 resources', () => {
    const resources = Array.from({ length: 5_000 }, (_, i) => ({
      kind: 'script',
      start: 1,
      end: i < 2_000 ? 100 : 400,
    }))
    expect(loadSplit({ ...snapshot(), resources })).toMatchObject({
      scripts: 60,
      scriptCount: 2_000,
    })
  })
})
