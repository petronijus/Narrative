/**
 * transitions/fade.test.ts
 *
 * Tests for the 'fade' cross-fade slide transition.
 * Verifies:
 *   - durationMs > 0: two proxy tweens created, correct from/to on alpha
 *   - durationMs === 0: immediate settle, no tween animation
 *   - Proxy pattern compliance (GSAP target is the proxy object, not the container)
 */

import { describe, it, expect } from 'vitest'
import { fadeTransition } from './fade.js'
import type { SlideTransitionTargets } from './types.js'
import type { SlideTransition } from '@narrative/shared'

function makeContainer(initialAlpha = 1) {
  const state = { x: 0, y: 0, scaleX: 1, scaleY: 1, alpha: initialAlpha }
  return {
    position: {
      set(x: number, y: number) {
        state.x = x
        state.y = y
      },
    },
    scale: {
      set(x: number, y: number) {
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
    _state: state,
  }
}

function makeTargets(
  outAlpha = 1,
  inAlpha = 0,
): SlideTransitionTargets & {
  outgoing: ReturnType<typeof makeContainer>
  incoming: ReturnType<typeof makeContainer>
} {
  return {
    outgoing: makeContainer(outAlpha),
    incoming: makeContainer(inAlpha),
    slideSize: { width: 1280, height: 720 },
  }
}

describe('fadeTransition — durationMs > 0', () => {
  const transition: SlideTransition = { kind: 'fade', durationMs: 500 }

  it('creates exactly 2 tweens in the timeline', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)

    const children = timeline.getChildren(false)
    expect(children).toHaveLength(2)

    dispose()
  })

  it('sets incoming.alpha to 0 before animation starts', () => {
    const targets = makeTargets(1, 1) // incoming starts at 1
    fadeTransition(targets, transition)
    // After compile (before play), incoming alpha should be 0
    expect(targets.incoming._state.alpha).toBe(0)
  })

  it('timeline duration matches durationMs / 1000', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)

    expect(timeline.duration()).toBeCloseTo(0.5, 2)
    dispose()
  })

  it('both tweens target proxy objects (not the containers directly)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)

    const children = timeline.getChildren(false) as gsap.core.Tween[]
    for (const child of children) {
      // Each tween's target should be a plain proxy object, not a container
      const tweenTargets = child.targets()
      for (const t of tweenTargets) {
        // A proxy has flat numeric alpha — containers have getter/setter
        expect(typeof t).toBe('object')
        // The proxy is NOT the original container (structural check)
        expect(t).not.toBe(targets.outgoing)
        expect(t).not.toBe(targets.incoming)
      }
    }

    dispose()
  })

  it('tweens start at position 0 (parallel, not sequential)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)

    // Both tweens should start at time 0 → total duration = durationMs/1000, not doubled
    expect(timeline.duration()).toBeCloseTo(0.5, 2)

    dispose()
  })

  it('seeking to end applies outgoing.alpha ≈ 0 and incoming.alpha ≈ 1', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)

    // Seek to end forces onUpdate to flush final values
    timeline.seek(0.5, false)

    expect(targets.outgoing._state.alpha).toBeCloseTo(0, 1)
    expect(targets.incoming._state.alpha).toBeCloseTo(1, 1)

    dispose()
  })
})

describe('fadeTransition — durationMs === 0', () => {
  const transition: SlideTransition = { kind: 'fade', durationMs: 0 }

  it('immediately sets outgoing.alpha = 0', () => {
    const targets = makeTargets()
    fadeTransition(targets, transition)
    expect(targets.outgoing._state.alpha).toBe(0)
  })

  it('immediately sets incoming.alpha = 1', () => {
    const targets = makeTargets()
    fadeTransition(targets, transition)
    expect(targets.incoming._state.alpha).toBe(1)
  })

  it('returns a timeline (API uniformity)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = fadeTransition(targets, transition)
    expect(typeof timeline.play).toBe('function')
    dispose()
  })
})
