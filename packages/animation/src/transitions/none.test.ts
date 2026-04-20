/**
 * transitions/none.test.ts
 *
 * Tests for the 'none' instant-swap transition.
 * Verifies: no animation tween, immediate state settle, API uniformity (timeline returned).
 */

import { describe, it, expect } from 'vitest'
import { noneTransition } from './none.js'
import type { SlideTransitionTargets } from './types.js'
import type { SlideTransition } from '@narrative/shared'

function makeContainer() {
  const state = { x: 0, y: 0, scaleX: 1, scaleY: 1, alpha: 1 }
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

function makeTargets(): SlideTransitionTargets & {
  outgoing: ReturnType<typeof makeContainer>
  incoming: ReturnType<typeof makeContainer>
} {
  const outgoing = makeContainer()
  const incoming = makeContainer()
  return {
    outgoing,
    incoming,
    slideSize: { width: 1280, height: 720 },
  }
}

const noneTransitionDef: SlideTransition = { kind: 'none', durationMs: 0 }

describe('noneTransition', () => {
  it('sets outgoing.alpha = 0 immediately', () => {
    const targets = makeTargets()
    noneTransition(targets, noneTransitionDef)
    expect(targets.outgoing._state.alpha).toBe(0)
  })

  it('sets incoming.alpha = 1 immediately', () => {
    const targets = makeTargets()
    noneTransition(targets, noneTransitionDef)
    expect(targets.incoming._state.alpha).toBe(1)
  })

  it('resets both containers to position (0,0)', () => {
    const targets = makeTargets()
    targets.outgoing.position.set(100, 50)
    targets.incoming.position.set(-200, 0)
    noneTransition(targets, noneTransitionDef)
    expect(targets.outgoing._state.x).toBe(0)
    expect(targets.outgoing._state.y).toBe(0)
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBe(0)
  })

  it('returns a timeline (API uniformity)', () => {
    const targets = makeTargets()
    const { timeline } = noneTransition(targets, noneTransitionDef)
    expect(timeline).toBeDefined()
    expect(typeof timeline.play).toBe('function')
    timeline.kill()
  })

  it('timeline duration is 0 (instant)', () => {
    const targets = makeTargets()
    const { timeline } = noneTransition(targets, noneTransitionDef)
    expect(timeline.duration()).toBe(0)
    timeline.kill()
  })

  it('dispose kills the timeline without error', () => {
    const targets = makeTargets()
    const { dispose } = noneTransition(targets, noneTransitionDef)
    expect(() => dispose()).not.toThrow()
  })
})
