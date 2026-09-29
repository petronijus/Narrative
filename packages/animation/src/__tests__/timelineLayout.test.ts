/**
 * animation/src/__tests__/timelineLayout.test.ts
 *
 * `layoutAnimationSteps` (@narrative/shared) says where each step starts on
 * a slide's timeline: the editor's timeline draws the bars there and
 * `animation.retime` places steps by it. These pin it against the real
 * compiler (`compileSteps`, GSAP) for the time-driven triggers, including a
 * legacy onEnter in the middle of a sequence, so the bars sit exactly where
 * playback puts them.
 *
 * (onClick is left out on purpose: the compiler anchors a click pause at
 * the timeline END — `tl.duration()` — while the layout draws it at the
 * previous step's end. Those differ after an overlapping withPrevious;
 * that is a separate, known display gap, not part of this contract.)
 */

import { describe, expect, it } from 'vitest'
import { layoutAnimationSteps, type AnimationTrigger } from '@narrative/shared'
import { compileSteps } from '../compiler.js'
import type { AnimationStep } from '../types.js'

function step(
  id: string,
  trigger: AnimationTrigger,
  duration: number,
  delay: number,
): AnimationStep {
  return { id, objectId: `obj-${id}`, preset: 'fadeIn', trigger, duration, delay, easing: 'none' }
}

/**
 * Absolute start (s) of every compiled tween, in STEP order. GSAP keeps a
 * timeline's children sorted by start time, so tweens are matched back to
 * their step through the per-object proxy they animate.
 */
function compiledStarts(steps: AnimationStep[]): number[] {
  const proxies = new Map<string, object>()
  const compiled = compileSteps(steps, {
    targetResolver: {
      resolve: (objectId: string) => {
        const proxy = { x: 0, y: 0, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 }
        proxies.set(objectId, proxy)
        return { kind: 'pixi', proxy, apply: () => {} }
      },
    },
  } as unknown as Parameters<typeof compileSteps>[1])
  try {
    const tweens = compiled.gsapTimeline.getChildren(false, true, false)
    return steps.map((s) => {
      const proxy = proxies.get(s.objectId)
      const tween = tweens.find((t) => t.targets()[0] === proxy)
      if (tween === undefined) throw new Error(`no tween compiled for step ${s.id}`)
      return tween.startTime()
    })
  } finally {
    compiled.dispose()
  }
}

function layoutStarts(steps: AnimationStep[]): number[] {
  return layoutAnimationSteps(steps).map((l) => l.start)
}

describe('layoutAnimationSteps mirrors compileSteps', () => {
  const cases: Array<[string, AnimationStep[]]> = [
    [
      'afterPrevious / withPrevious chain',
      [
        step('a', 'afterPrevious', 1, 0.5),
        step('b', 'afterPrevious', 0.5, 0.25),
        step('c', 'withPrevious', 2, 0.1),
      ],
    ],
    [
      'legacy onEnter first step',
      [step('a', 'onEnter', 0.6, 0), step('b', 'afterPrevious', 0.6, 0)],
    ],
    [
      // The case the old on-open migration broke: onEnter anchors at the
      // slide start, so this step starts at 0.2 s — BEFORE its predecessor
      // ends (1.5 s). afterPrevious with delay max(0, 0.2 - 1.5) = 0 moved
      // it to 1.5 s.
      'legacy onEnter mid-sequence, starting before its predecessor ends',
      [
        step('a', 'afterPrevious', 1, 0.5),
        step('b', 'onEnter', 1, 0.2),
        step('c', 'withPrevious', 0.5, 0.3),
        step('d', 'afterPrevious', 0.5, 0),
      ],
    ],
    [
      'legacy onEnter mid-sequence, starting after its predecessor ends',
      [step('a', 'afterPrevious', 1, 0), step('b', 'onEnter', 0.5, 3)],
    ],
  ]

  it.each(cases)('%s', (_name, steps) => {
    const compiled = compiledStarts(steps)
    expect(compiled).toHaveLength(steps.length)
    const laid = layoutStarts(steps)
    laid.forEach((start, i) => expect(start).toBeCloseTo(compiled[i]!, 6))
  })

  it('places a mid-sequence onEnter at the slide start + delay', () => {
    const steps = cases[2]![1]
    expect(layoutStarts(steps)[1]).toBeCloseTo(0.2, 6)
  })
})
