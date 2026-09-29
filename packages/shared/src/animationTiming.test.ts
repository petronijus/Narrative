import { describe, expect, it } from 'vitest'
import type { AnimationStep, AnimationTrigger } from './animation.js'
import { layoutAnimationSteps } from './animationTiming.js'

function step(id: string, trigger: AnimationTrigger, duration: number, delay = 0): AnimationStep {
  return { id, objectId: 'o', preset: 'fadeIn', trigger, duration, delay, easing: 'none' }
}

const startsOf = (steps: AnimationStep[]): Record<string, number> =>
  Object.fromEntries(layoutAnimationSteps(steps).map((t) => [t.step.id, t.start]))

describe('layoutAnimationSteps', () => {
  it('starts the first step at its delay, whatever its trigger', () => {
    expect(startsOf([step('a', 'onClick', 1, 0.5)])).toEqual({ a: 0.5 })
    expect(startsOf([step('a', 'withPrevious', 1, 0.25)])).toEqual({ a: 0.25 })
  })

  it('chains afterPrevious and onClick from the previous end, withPrevious from its start', () => {
    expect(
      startsOf([
        step('a', 'afterPrevious', 1),
        step('b', 'afterPrevious', 2, 0.5),
        step('c', 'withPrevious', 1, 0.25),
        step('d', 'onClick', 1),
      ]),
    ).toEqual({ a: 0, b: 1.5, c: 1.75, d: 2.75 })
  })

  it('anchors a legacy onEnter step at the slide start wherever it sits', () => {
    expect(startsOf([step('a', 'afterPrevious', 3), step('b', 'onEnter', 1, 0.5)])).toEqual({
      a: 0,
      b: 0.5,
    })
  })
})
