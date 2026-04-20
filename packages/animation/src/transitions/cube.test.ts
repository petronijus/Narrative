/**
 * transitions/cube.test.ts
 *
 * Tests for the 'cube' 2D-approximation slide transition.
 * Verifies: scale + alpha semantics for outgoing and incoming containers.
 */

import { describe, it, expect } from 'vitest'
import { cubeTransition } from './cube.js'
import type { SlideTransitionTargets } from './types.js'
import type { SlideTransition } from '@narrative/shared'

const SLIDE_W = 1280
const SLIDE_H = 720
const SHRINK = 0.92

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
  return {
    outgoing: makeContainer(),
    incoming: makeContainer(),
    slideSize: { width: SLIDE_W, height: SLIDE_H },
  }
}

describe('cubeTransition — initial state setup', () => {
  const transition: SlideTransition = { kind: 'cube', durationMs: 500, direction: 'left' }

  it('outgoing starts at scale 1 + alpha 1 + position (0,0)', () => {
    const targets = makeTargets()
    cubeTransition(targets, transition)
    expect(targets.outgoing._state.scaleX).toBe(1)
    expect(targets.outgoing._state.scaleY).toBe(1)
    expect(targets.outgoing._state.alpha).toBe(1)
    expect(targets.outgoing._state.x).toBe(0)
    expect(targets.outgoing._state.y).toBe(0)
  })

  it('incoming starts at scale 0.92 + alpha 0 + half-distance offset (left → positive x)', () => {
    const targets = makeTargets()
    cubeTransition(targets, transition)
    expect(targets.incoming._state.scaleX).toBeCloseTo(SHRINK, 5)
    expect(targets.incoming._state.scaleY).toBeCloseTo(SHRINK, 5)
    expect(targets.incoming._state.alpha).toBe(0)
    expect(targets.incoming._state.x).toBeCloseTo(SLIDE_W * 0.5, 0)
    expect(targets.incoming._state.y).toBe(0)
  })
})

describe('cubeTransition — settled state (seek to end)', () => {
  const transition: SlideTransition = { kind: 'cube', durationMs: 500, direction: 'left' }

  it('outgoing ends at scale 0.92 + alpha 0', () => {
    const targets = makeTargets()
    const { timeline, dispose } = cubeTransition(targets, transition)
    timeline.seek(0.5, false)
    expect(targets.outgoing._state.scaleX).toBeCloseTo(SHRINK, 1)
    expect(targets.outgoing._state.scaleY).toBeCloseTo(SHRINK, 1)
    expect(targets.outgoing._state.alpha).toBeCloseTo(0, 1)
    dispose()
  })

  it('incoming ends at scale 1 + alpha 1 + position (0,0)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = cubeTransition(targets, transition)
    timeline.seek(0.5, false)
    expect(targets.incoming._state.scaleX).toBeCloseTo(1, 1)
    expect(targets.incoming._state.scaleY).toBeCloseTo(1, 1)
    expect(targets.incoming._state.alpha).toBeCloseTo(1, 1)
    expect(targets.incoming._state.x).toBeCloseTo(0, 0)
    expect(targets.incoming._state.y).toBeCloseTo(0, 0)
    dispose()
  })
})

describe('cubeTransition — direction variants (incoming start offset)', () => {
  it('direction: right → incoming starts at x=-slideWidth*0.5', () => {
    const targets = makeTargets()
    cubeTransition(targets, { kind: 'cube', durationMs: 500, direction: 'right' })
    expect(targets.incoming._state.x).toBeCloseTo(-SLIDE_W * 0.5, 0)
    expect(targets.incoming._state.y).toBe(0)
  })

  it('direction: up → incoming starts at y=+slideHeight*0.5', () => {
    const targets = makeTargets()
    cubeTransition(targets, { kind: 'cube', durationMs: 500, direction: 'up' })
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBeCloseTo(SLIDE_H * 0.5, 0)
  })

  it('direction: down → incoming starts at y=-slideHeight*0.5', () => {
    const targets = makeTargets()
    cubeTransition(targets, { kind: 'cube', durationMs: 500, direction: 'down' })
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBeCloseTo(-SLIDE_H * 0.5, 0)
  })
})

describe('cubeTransition — durationMs === 0', () => {
  const transition: SlideTransition = { kind: 'cube', durationMs: 0, direction: 'left' }

  it('immediately settles: outgoing alpha=0, scale=0.92', () => {
    const targets = makeTargets()
    cubeTransition(targets, transition)
    expect(targets.outgoing._state.alpha).toBe(0)
    expect(targets.outgoing._state.scaleX).toBeCloseTo(SHRINK, 5)
  })

  it('immediately settles: incoming alpha=1, scale=1, position (0,0)', () => {
    const targets = makeTargets()
    cubeTransition(targets, transition)
    expect(targets.incoming._state.alpha).toBe(1)
    expect(targets.incoming._state.scaleX).toBe(1)
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBe(0)
  })
})

describe('cubeTransition — parallel tweens', () => {
  it('creates 2 tweens (outgoing + incoming animated together)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = cubeTransition(targets, {
      kind: 'cube',
      durationMs: 500,
      direction: 'left',
    })
    expect(timeline.getChildren(false)).toHaveLength(2)
    dispose()
  })

  it('both tweens start at position 0 → total duration = durationMs/1000', () => {
    const targets = makeTargets()
    const { timeline, dispose } = cubeTransition(targets, {
      kind: 'cube',
      durationMs: 600,
      direction: 'left',
    })
    expect(timeline.duration()).toBeCloseTo(0.6, 2)
    dispose()
  })
})
