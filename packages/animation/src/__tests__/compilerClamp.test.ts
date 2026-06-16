/**
 * compilerClamp.test.ts
 *
 * Safety-clamp tests for the DSL → GSAP compiler. Hostile/legacy animation
 * values (effectively-infinite duration, repeat-forever) must be silently
 * capped so they can't ship a runaway timeline to viewers (client-side DoS).
 * Well-behaved values must pass through untouched.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  compileSteps,
  clampStep,
  MAX_STEP_DURATION_S,
  MAX_TIMELINE_DURATION_S,
  MAX_REPEAT,
} from '../compiler.js'
import type {
  AnimationStep,
  AnimationContext,
  PixiTargetHandle,
  DomTargetHandle,
  TargetResolver,
} from '../types.js'

function makePixiTarget(): PixiTargetHandle {
  return {
    kind: 'pixi',
    proxy: { x: 0, y: 0, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 },
    apply: vi.fn(),
  }
}

function makeResolver(targets: Map<string, PixiTargetHandle | DomTargetHandle>): TargetResolver {
  return { resolve: (objectId) => targets.get(objectId) ?? null }
}

function makeStep(
  overrides: Partial<AnimationStep> & Pick<AnimationStep, 'id' | 'objectId'>,
): AnimationStep {
  return {
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

function ctxFor(objectId: string): AnimationContext {
  const targets = new Map<string, PixiTargetHandle | DomTargetHandle>([
    [objectId, makePixiTarget()],
  ])
  return { targetResolver: makeResolver(targets) }
}

describe('compileSteps — safety clamps', () => {
  it('clamps an extreme single-step duration to MAX_STEP_DURATION_S', () => {
    const step = makeStep({ id: 's1', objectId: 'o1', duration: 1_000_000 })
    const { gsapTimeline, dispose } = compileSteps([step], ctxFor('o1'))
    // fadeIn emits a single tween whose duration == step.duration (clamped).
    expect(gsapTimeline.duration()).toBeCloseTo(MAX_STEP_DURATION_S, 1)
    dispose()
  })

  it('clamps an Infinity duration to MAX_STEP_DURATION_S', () => {
    const step = makeStep({ id: 's1', objectId: 'o1', duration: Number.POSITIVE_INFINITY })
    const { gsapTimeline, dispose } = compileSteps([step], ctxFor('o1'))
    expect(gsapTimeline.duration()).toBeCloseTo(MAX_STEP_DURATION_S, 1)
    dispose()
  })

  it('leaves a normal duration untouched', () => {
    const step = makeStep({ id: 's1', objectId: 'o1', duration: 0.75 })
    const { gsapTimeline, dispose } = compileSteps([step], ctxFor('o1'))
    expect(gsapTimeline.duration()).toBeCloseTo(0.75, 2)
    dispose()
  })

  it('bounds the cumulative timeline to MAX_TIMELINE_DURATION_S across many steps', () => {
    const targets = new Map<string, PixiTargetHandle | DomTargetHandle>()
    const steps: AnimationStep[] = []
    // 10 steps each wanting MAX_STEP_DURATION_S, sequential → would be 6000s.
    for (let i = 0; i < 10; i++) {
      const id = `o${i}`
      targets.set(id, makePixiTarget())
      steps.push(
        makeStep({
          id: `s${i}`,
          objectId: id,
          duration: MAX_STEP_DURATION_S,
          trigger: i === 0 ? 'onEnter' : 'afterPrevious',
        }),
      )
    }
    const ctx: AnimationContext = { targetResolver: makeResolver(targets) }
    const { gsapTimeline, dispose } = compileSteps(steps, ctx)
    // Total must never exceed the global budget (small epsilon for FP).
    expect(gsapTimeline.duration()).toBeLessThanOrEqual(MAX_TIMELINE_DURATION_S + 1)
    dispose()
  })

  it('clamps a repeat-forever (-1) param to MAX_REPEAT without mutating the original', () => {
    const original = makeStep({ id: 's1', objectId: 'o1', params: { repeat: -1 } })
    const { step } = clampStep(original)
    expect(step.params?.['repeat']).toBe(MAX_REPEAT)
    // Non-mutating: the caller's object is untouched.
    expect(original.params?.['repeat']).toBe(-1)
  })

  it('clamps an over-limit repeat down to MAX_REPEAT', () => {
    const { step } = clampStep(makeStep({ id: 's1', objectId: 'o1', params: { repeat: 9999 } }))
    expect(step.params?.['repeat']).toBe(MAX_REPEAT)
  })

  it('leaves a within-bounds repeat untouched', () => {
    const original = makeStep({ id: 's1', objectId: 'o1', params: { repeat: 3 } })
    const { step } = clampStep(original)
    expect(step.params?.['repeat']).toBe(3)
  })

  it('clamps duration but returns the same object reference when nothing changes', () => {
    const original = makeStep({ id: 's1', objectId: 'o1', duration: 0.5, delay: 0 })
    const { step } = clampStep(original)
    expect(step).toBe(original)
  })
})
