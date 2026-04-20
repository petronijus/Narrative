/**
 * transitions/push.test.ts
 *
 * Tests for the 'push' slide transition — all 4 directions.
 * Verifies: correct from/to positions for outgoing and incoming proxies.
 */

import { describe, it, expect } from 'vitest'
import { pushTransition } from './push.js'
import type { SlideTransitionTargets } from './types.js'
import type { SlideTransition } from '@narrative/shared'

const SLIDE_W = 1280
const SLIDE_H = 720

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

function seekToEnd(
  targets: SlideTransitionTargets & {
    outgoing: ReturnType<typeof makeContainer>
    incoming: ReturnType<typeof makeContainer>
  },
  transition: SlideTransition,
) {
  const { timeline, dispose } = pushTransition(targets, transition)
  const dur = timeline.duration()
  timeline.seek(dur, false)
  dispose()
  return targets
}

describe('pushTransition — direction: left', () => {
  const transition: SlideTransition = { kind: 'push', durationMs: 400, direction: 'left' }

  it('incoming starts at x=+slideWidth', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    // Before play, incoming should be positioned at the start offset
    expect(targets.incoming._state.x).toBe(SLIDE_W)
    expect(targets.incoming._state.y).toBe(0)
  })

  it('after transition: outgoing ends at x=-slideWidth', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.outgoing._state.x).toBeCloseTo(-SLIDE_W, 0)
  })

  it('after transition: incoming ends at (0, 0)', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.incoming._state.x).toBeCloseTo(0, 0)
    expect(settled.incoming._state.y).toBeCloseTo(0, 0)
  })

  it('creates 2 tweens (parallel)', () => {
    const targets = makeTargets()
    const { timeline, dispose } = pushTransition(targets, transition)
    expect(timeline.getChildren(false)).toHaveLength(2)
    dispose()
  })
})

describe('pushTransition — direction: right', () => {
  const transition: SlideTransition = { kind: 'push', durationMs: 400, direction: 'right' }

  it('incoming starts at x=-slideWidth', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    expect(targets.incoming._state.x).toBe(-SLIDE_W)
    expect(targets.incoming._state.y).toBe(0)
  })

  it('after transition: outgoing ends at x=+slideWidth', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.outgoing._state.x).toBeCloseTo(SLIDE_W, 0)
  })

  it('after transition: incoming ends at (0, 0)', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.incoming._state.x).toBeCloseTo(0, 0)
    expect(settled.incoming._state.y).toBeCloseTo(0, 0)
  })
})

describe('pushTransition — direction: up', () => {
  const transition: SlideTransition = { kind: 'push', durationMs: 400, direction: 'up' }

  it('incoming starts at y=+slideHeight', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBe(SLIDE_H)
  })

  it('after transition: outgoing ends at y=-slideHeight', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.outgoing._state.y).toBeCloseTo(-SLIDE_H, 0)
  })

  it('after transition: incoming ends at (0, 0)', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.incoming._state.x).toBeCloseTo(0, 0)
    expect(settled.incoming._state.y).toBeCloseTo(0, 0)
  })
})

describe('pushTransition — direction: down', () => {
  const transition: SlideTransition = { kind: 'push', durationMs: 400, direction: 'down' }

  it('incoming starts at y=-slideHeight', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBe(-SLIDE_H)
  })

  it('after transition: outgoing ends at y=+slideHeight', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.outgoing._state.y).toBeCloseTo(SLIDE_H, 0)
  })

  it('after transition: incoming ends at (0, 0)', () => {
    const targets = makeTargets()
    const settled = seekToEnd(targets, transition)
    expect(settled.incoming._state.x).toBeCloseTo(0, 0)
    expect(settled.incoming._state.y).toBeCloseTo(0, 0)
  })
})

describe('pushTransition — durationMs === 0', () => {
  const transition: SlideTransition = { kind: 'push', durationMs: 0, direction: 'left' }

  it('immediately settles outgoing off-screen', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    expect(targets.outgoing._state.x).toBe(-SLIDE_W)
  })

  it('immediately settles incoming at (0,0)', () => {
    const targets = makeTargets()
    pushTransition(targets, transition)
    expect(targets.incoming._state.x).toBe(0)
    expect(targets.incoming._state.y).toBe(0)
  })
})

describe('pushTransition — default direction', () => {
  it('defaults to left when direction is omitted', () => {
    const transition: SlideTransition = { kind: 'push', durationMs: 400 }
    const targets = makeTargets()
    pushTransition(targets, transition)
    // 'left' means incoming starts at +slideWidth
    expect(targets.incoming._state.x).toBe(SLIDE_W)
  })
})
