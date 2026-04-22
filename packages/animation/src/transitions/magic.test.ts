/**
 * transitions/magic.test.ts
 *
 * Tests for the 'magic' (Magic Move) slide transition.
 *
 * Verifies:
 *   - No pairs → behaves like a plain fade (root crossfade only)
 *   - One pair → matched object is seeded at outgoing transform and tweens to incoming
 *   - durationMs === 0 → immediate settle
 *   - Proxy pattern compliance (GSAP targets are plain proxies, not Pixi containers)
 *   - End state: incoming container lands exactly on its target transform
 */

import { describe, it, expect } from 'vitest'
import { magicTransition } from './magic.js'
import type { SlideTransitionTargets, MagicMoveObjectPair } from './types.js'
import type { SlideTransition } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Test doubles — plain structural containers matching the PixiContainer interface
// ---------------------------------------------------------------------------

interface MockContainer {
  _state: {
    x: number
    y: number
    scaleX: number
    scaleY: number
    alpha: number
    rotation: number
  }
  position: { set(x: number, y: number): void }
  scale: {
    x: number
    y: number
    set(x: number, y: number): void
  }
  alpha: number
  rotation: number
  x: number
  y: number
}

function makeContainer(init?: Partial<MockContainer['_state']>): MockContainer {
  const state = {
    x: init?.x ?? 0,
    y: init?.y ?? 0,
    scaleX: init?.scaleX ?? 1,
    scaleY: init?.scaleY ?? 1,
    alpha: init?.alpha ?? 1,
    rotation: init?.rotation ?? 0,
  }
  const c: MockContainer = {
    _state: state,
    position: {
      set(x, y) {
        state.x = x
        state.y = y
      },
    },
    scale: {
      get x() {
        return state.scaleX
      },
      get y() {
        return state.scaleY
      },
      set(x, y) {
        state.scaleX = x
        state.scaleY = y
      },
    },
    get alpha() {
      return state.alpha
    },
    set alpha(v: number) {
      state.alpha = v
    },
    get rotation() {
      return state.rotation
    },
    set rotation(v: number) {
      state.rotation = v
    },
    get x() {
      return state.x
    },
    get y() {
      return state.y
    },
  }
  return c
}

function makeTargets(pairs: MagicMoveObjectPair[] = []): SlideTransitionTargets {
  return {
    outgoing: makeContainer({ alpha: 1 }),
    incoming: makeContainer({ alpha: 0 }),
    slideSize: { width: 1920, height: 1080 },
    magicPairs: pairs,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('magicTransition — durationMs > 0', () => {
  const transition: SlideTransition = { kind: 'magic', durationMs: 600 }

  it('creates no tweens when there are no pairs and no unmatched children', () => {
    // Magic Move no longer crossfades the root containers — it keeps them at
    // alpha 1 and fades individual unmatched children. With zero pairs and
    // zero children the timeline is legitimately empty; runSlideTransition
    // still fires onComplete on the next microtask.
    const targets = makeTargets([])
    const { timeline, dispose } = magicTransition(targets, transition)

    const children = timeline.getChildren(false)
    expect(children).toHaveLength(0)

    dispose()
  })

  it('seeded incoming containers land on the outgoing snapshot at t=0', () => {
    const outObj = makeContainer({ x: 100, y: 200, scaleX: 1, scaleY: 1, alpha: 1, rotation: 0 })
    const inObj = makeContainer({
      x: 800, // target, should be overwritten by seeding
      y: 400,
      scaleX: 2,
      scaleY: 2,
      alpha: 1,
      rotation: Math.PI / 2,
    })
    const pair: MagicMoveObjectPair = {
      id: 'obj-1',
      outgoing: outObj,
      incoming: inObj,
    }
    const targets = makeTargets([pair])
    const { timeline, dispose } = magicTransition(targets, transition)

    // Magic factory reads both snapshots BEFORE seeding (so "to" = the real
    // target the renderer mounted) and THEN overwrites the incoming with the
    // outgoing snapshot.
    expect(inObj._state.x).toBe(100)
    expect(inObj._state.y).toBe(200)
    expect(inObj._state.scaleX).toBe(1)
    expect(inObj._state.alpha).toBe(1)
    expect(inObj._state.rotation).toBe(0)

    dispose()
  })

  it('seeking to end lands incoming on the captured target transform', () => {
    const outObj = makeContainer({ x: 0, y: 0, scaleX: 1, scaleY: 1, alpha: 1, rotation: 0 })
    const inObj = makeContainer({
      x: 500,
      y: 300,
      scaleX: 1.5,
      scaleY: 1.5,
      alpha: 0.7,
      rotation: 1,
    })
    const targets = makeTargets([
      {
        id: 'obj-1',
        outgoing: outObj,
        incoming: inObj,
      },
    ])
    const { timeline, dispose } = magicTransition(targets, transition)

    timeline.seek(transition.durationMs / 1000, false)
    // Fire onComplete manually — timeline.seek to end does not always trigger it
    // in paused timelines depending on GSAP version; magicTransition's snap
    // code is exposed via the onComplete handler.
    const onComplete = timeline.eventCallback('onComplete')
    if (typeof onComplete === 'function') onComplete()

    expect(inObj._state.x).toBeCloseTo(500, 1)
    expect(inObj._state.y).toBeCloseTo(300, 1)
    expect(inObj._state.scaleX).toBeCloseTo(1.5, 2)
    expect(inObj._state.alpha).toBeCloseTo(0.7, 1)
    expect(inObj._state.rotation).toBeCloseTo(1, 1)

    dispose()
  })

  it('creates 1 per-pair morph tween per matched object', () => {
    const pair: MagicMoveObjectPair = {
      id: 'obj-1',
      outgoing: makeContainer(),
      incoming: makeContainer({ x: 50 }),
    }
    const targets = makeTargets([pair])
    const { timeline, dispose } = magicTransition(targets, transition)

    const children = timeline.getChildren(false)
    // Single morph tween on the incoming container. Outgoing copy is hidden
    // by a synchronous alpha=0 snap (no tween) so it doesn't double-render
    // with the seeded incoming at t=0.
    expect(children).toHaveLength(1)

    dispose()
  })

  it('tween targets are plain proxy objects (not PixiContainers)', () => {
    const pair: MagicMoveObjectPair = {
      id: 'obj-1',
      outgoing: makeContainer(),
      incoming: makeContainer({ x: 10 }),
    }
    const targets = makeTargets([pair])
    const { timeline, dispose } = magicTransition(targets, transition)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gsap tween.targets() returns any[]
    const children = timeline.getChildren(false) as any[]
    for (const child of children) {
      const tweenTargets = child.targets()
      for (const t of tweenTargets) {
        expect(t).not.toBe(targets.outgoing)
        expect(t).not.toBe(targets.incoming)
        expect(t).not.toBe(pair.outgoing)
        expect(t).not.toBe(pair.incoming)
      }
    }

    dispose()
  })
})

describe('magicTransition — outgoing copy is snapped hidden at t=0', () => {
  const transition: SlideTransition = { kind: 'magic', durationMs: 600 }

  it('snaps pair.outgoing.alpha to 0 without touching its position/scale', () => {
    // Two-copy double-render regression: previously the outgoing copy was
    // tweened 1→0 over 150ms while the incoming was seeded at from.alpha
    // at the same position. Two copies compositing with "over" alpha
    // produced a visible blink-up at t=0 for source alphas < 1 (e.g.
    // two 0.5 alphas compose to 0.75). Fix: snap outgoing alpha to 0
    // synchronously; leave position/scale untouched so the incoming's
    // seed is the only visible copy from frame 1.
    const outObj = makeContainer({
      x: 320,
      y: 240,
      scaleX: 1.25,
      scaleY: 1.25,
      alpha: 1,
    })
    const inObj = makeContainer({ x: 600, y: 400, scaleX: 1, scaleY: 1, alpha: 1 })
    const targets = makeTargets([{ id: 'obj-1', outgoing: outObj, incoming: inObj }])
    const { timeline, dispose } = magicTransition(targets, transition)

    // Outgoing position/scale must be unchanged — magic.ts must never stomp
    // them to default proxy values.
    expect(outObj._state.x).toBe(320)
    expect(outObj._state.y).toBe(240)
    expect(outObj._state.scaleX).toBeCloseTo(1.25, 2)
    expect(outObj._state.scaleY).toBeCloseTo(1.25, 2)
    // Alpha was snapped to 0 by the factory itself (no tween).
    expect(outObj._state.alpha).toBe(0)

    dispose()
  })
})

describe('magicTransition — durationMs === 0', () => {
  const transition: SlideTransition = { kind: 'magic', durationMs: 0 }

  it('immediately snaps outgoing.alpha to 0 and incoming.alpha to 1', () => {
    const targets = makeTargets()
    magicTransition(targets, transition)
    const outgoing = targets.outgoing as unknown as MockContainer
    const incoming = targets.incoming as unknown as MockContainer
    expect(outgoing._state.alpha).toBe(0)
    expect(incoming._state.alpha).toBe(1)
  })

  it('returns a timeline for API uniformity with other kinds', () => {
    const targets = makeTargets()
    const { timeline, dispose } = magicTransition(targets, transition)
    expect(typeof timeline.play).toBe('function')
    dispose()
  })
})
