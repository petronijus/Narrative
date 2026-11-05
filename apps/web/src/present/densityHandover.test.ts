/**
 * present/densityHandover.test.ts — present mode following a display-density
 * change: a standby set is prepared while the old one presents, takes over
 * at once on a still slide or at the next boundary, is cancelled by a second
 * change, and dropped when the display goes back to the density on stage.
 * The display watch re-arms its media query on every change.
 */

import { describe, expect, it } from 'vitest'
import { DensityHandover, type DensityHandoverDeps } from './densityHandover.js'
import { watchDevicePixelRatio, type DensityEnv } from '../renderer/devicePixelRatioWatch.js'

interface FakeSet {
  density: number
  ready: boolean
  destroyed: boolean
  listeners: Set<() => void>
}

function harness(opts: { still: boolean }) {
  const log: string[] = []
  let presenting = 1
  let still = opts.still
  let armed: FakeSet | null = null
  const sets: FakeSet[] = []
  const deps: DensityHandoverDeps<FakeSet> = {
    currentDensity: () => presenting,
    createSet: (density) => {
      const set: FakeSet = { density, ready: false, destroyed: false, listeners: new Set() }
      sets.push(set)
      log.push(`create ${density}`)
      return set
    },
    destroySet: (set) => {
      set.destroyed = true
      log.push(`destroy ${set.density}`)
    },
    subscribe: (set, l) => {
      set.listeners.add(l)
      return () => set.listeners.delete(l)
    },
    isReady: (set) => set.ready,
    swapNow: (set, density) => {
      if (!still) return false
      presenting = density
      log.push(`swap now ${set.density}`)
      return true
    },
    armBoundary: (set) => {
      armed = set
      log.push(`arm ${set.density}`)
    },
    disarmBoundary: () => {
      log.push(`disarm ${armed?.density}`)
      armed = null
    },
  }
  const handover = new DensityHandover(deps)
  const ready = (set: FakeSet): void => {
    set.ready = true
    for (const l of [...set.listeners]) l()
  }
  /** The presentation crossed a slide boundary with the armed set. */
  const boundary = (): void => {
    if (armed === null) return
    presenting = armed.density
    log.push(`swap at boundary ${armed.density}`)
    armed = null
    handover.adopted()
  }
  return {
    handover,
    log,
    sets,
    ready,
    boundary,
    setStill: (v: boolean) => {
      still = v
    },
    presenting: () => presenting,
  }
}

describe('DensityHandover', () => {
  it('prepares a set for the new density and swaps at once on a still slide', () => {
    const h = harness({ still: true })
    h.handover.densityChanged(2)
    expect(h.handover.state.kind).toBe('preparing')
    expect(h.presenting()).toBe(1) // the old set presents until the new one is whole
    h.ready(h.sets[0]!)
    expect(h.log).toEqual(['create 2', 'swap now 2'])
    expect(h.presenting()).toBe(2)
    expect(h.handover.state.kind).toBe('idle')
  })

  it('waits for the next slide boundary when the slide shown is not still', () => {
    const h = harness({ still: false })
    h.handover.densityChanged(2)
    h.ready(h.sets[0]!)
    expect(h.handover.state.kind).toBe('armed')
    expect(h.presenting()).toBe(1)
    h.boundary()
    expect(h.presenting()).toBe(2)
    expect(h.handover.state.kind).toBe('idle')
    expect(h.sets[0]!.destroyed).toBe(false) // it presents now
  })

  it('takes an armed set over at once once the slide allows it (retry)', () => {
    const h = harness({ still: false })
    h.handover.densityChanged(2)
    h.ready(h.sets[0]!)
    h.setStill(true)
    h.handover.retry()
    expect(h.log).toEqual(['create 2', 'arm 2', 'disarm 2', 'swap now 2'])
    expect(h.handover.state.kind).toBe('idle')
  })

  it('a second change cancels the set under way and starts over', () => {
    const h = harness({ still: true })
    h.handover.densityChanged(2)
    h.handover.densityChanged(1.5)
    expect(h.sets[0]!.destroyed).toBe(true)
    expect(h.handover.state).toMatchObject({ kind: 'preparing', density: 1.5 })
    // The cancelled set's late progress does nothing.
    h.ready(h.sets[0]!)
    expect(h.presenting()).toBe(1)
    h.ready(h.sets[1]!)
    expect(h.presenting()).toBe(1.5)
  })

  it('a change back to the density on stage drops the armed set', () => {
    const h = harness({ still: false })
    h.handover.densityChanged(2)
    h.ready(h.sets[0]!)
    h.handover.densityChanged(1)
    expect(h.log).toEqual(['create 2', 'arm 2', 'disarm 2', 'destroy 2'])
    expect(h.handover.state.kind).toBe('idle')
    h.boundary()
    expect(h.presenting()).toBe(1)
  })

  it('restart prepares the set under way again for its density (its grid moved)', () => {
    const h = harness({ still: false })
    h.handover.densityChanged(2)
    h.handover.restart()
    expect(h.sets[0]!.destroyed).toBe(true)
    expect(h.handover.state).toMatchObject({ kind: 'preparing', density: 2 })
    // An armed set too: disarmed, destroyed, prepared again.
    h.ready(h.sets[1]!)
    h.handover.restart()
    expect(h.log).toEqual([
      'create 2',
      'destroy 2',
      'create 2',
      'arm 2',
      'disarm 2',
      'destroy 2',
      'create 2',
    ])
    // The stale sets' late progress does nothing; the new one takes over.
    h.ready(h.sets[0]!)
    h.boundary()
    expect(h.presenting()).toBe(1)
    h.ready(h.sets[2]!)
    h.boundary()
    expect(h.presenting()).toBe(2)
    // Idle: nothing to restart.
    h.handover.restart()
    expect(h.sets).toHaveLength(3)
  })

  it('the same density again changes nothing; destroy frees the set under way', () => {
    const h = harness({ still: true })
    h.handover.densityChanged(2)
    h.handover.densityChanged(2)
    expect(h.sets).toHaveLength(1)
    h.handover.destroy()
    expect(h.sets[0]!.destroyed).toBe(true)
    h.handover.densityChanged(3)
    expect(h.sets).toHaveLength(1)
  })
})

describe('watchDevicePixelRatio', () => {
  function fakeEnv(initial: number) {
    const queries: Array<{ query: string; listeners: Set<() => void> }> = []
    const env: DensityEnv & { devicePixelRatio: number } = {
      devicePixelRatio: initial,
      matchMedia: (query) => {
        const q = { query, listeners: new Set<() => void>() }
        queries.push(q)
        return {
          addEventListener: (_: string, l: () => void) => q.listeners.add(l),
          removeEventListener: (_: string, l: () => void) => q.listeners.delete(l),
        } as unknown as MediaQueryList
      },
    }
    const change = (ratio: number): void => {
      env.devicePixelRatio = ratio
      const live = queries.filter((q) => q.listeners.size > 0)
      for (const q of live) for (const l of [...q.listeners]) l()
    }
    return { env, queries, change }
  }

  it('reports each change and re-arms a query for the new ratio', () => {
    const f = fakeEnv(1)
    const seen: number[] = []
    const stop = watchDevicePixelRatio((r) => seen.push(r), f.env)
    expect(f.queries.map((q) => q.query)).toEqual(['(resolution: 1dppx)'])
    f.change(2)
    f.change(1.5)
    expect(seen).toEqual([2, 1.5])
    expect(f.queries.map((q) => q.query)).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 2dppx)',
      '(resolution: 1.5dppx)',
    ])
    // Only the latest query listens.
    expect(f.queries.filter((q) => q.listeners.size > 0)).toHaveLength(1)
    stop()
    f.change(3)
    expect(seen).toEqual([2, 1.5])
    expect(f.queries.filter((q) => q.listeners.size > 0)).toHaveLength(0)
  })

  it('catches a change that came with a resize only, once', () => {
    const f = fakeEnv(1)
    const resize = new Set<() => void>()
    const env = {
      ...f.env,
      get devicePixelRatio() {
        return f.env.devicePixelRatio
      },
      matchMedia: f.env.matchMedia,
      addEventListener: (_: 'resize', l: () => void) => resize.add(l),
      removeEventListener: (_: 'resize', l: () => void) => resize.delete(l),
    }
    const seen: number[] = []
    const stop = watchDevicePixelRatio((r) => seen.push(r), env)
    f.env.devicePixelRatio = 2
    for (const l of [...resize]) l()
    // The media query reports the same change afterwards: not twice.
    for (const q of f.queries) for (const l of [...q.listeners]) l()
    for (const l of [...resize]) l() // a resize without a density change
    expect(seen).toEqual([2])
    stop()
    expect(resize.size).toBe(0)
  })
})
