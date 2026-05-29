/**
 * presets/authoredAlpha.test.ts
 *
 * Regression: in/out presets must respect the object's AUTHORED alpha
 * instead of snapping to a hardcoded 1. An object placed at alpha 0.6 must
 * settle at 0.6 on entrance and start from 0.6 on exit — not pop to full
 * opacity.
 */

import { describe, it, expect, vi } from 'vitest'
import { gsap } from 'gsap'
import { scaleIn } from '../../presets/scaleIn.js'
import { bounceIn } from '../../presets/bounceIn.js'
import { flipIn } from '../../presets/flipIn.js'
import { fadeOut } from '../../presets/fadeOut.js'
import { scaleOut } from '../../presets/scaleOut.js'
import type { AnimationStep, PixiTargetHandle } from '../../types.js'

const AUTHORED = 0.6

function makeStep(overrides?: Partial<AnimationStep>): AnimationStep {
  return {
    id: 'test-step',
    objectId: 'obj1',
    preset: 'scaleIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

function makePixiTarget(): PixiTargetHandle {
  // Authored at alpha 0.6 (the proxy is seeded from the container).
  const proxy = { x: 0, y: 0, rotation: 0, alpha: AUTHORED, scaleX: 1, scaleY: 1 }
  return { kind: 'pixi', proxy, apply: vi.fn() }
}

describe('presets respect authored alpha', () => {
  for (const [name, fn] of [
    ['scaleIn', scaleIn],
    ['bounceIn', bounceIn],
    ['flipIn', flipIn],
  ] as const) {
    it(`${name}: settles at authored alpha, not 1`, () => {
      const tl = gsap.timeline({ paused: true })
      const target = makePixiTarget()
      fn(makeStep({ preset: name }), target, tl, 0)
      tl.progress(1) // jump to end
      expect(target.proxy.alpha).toBeCloseTo(AUTHORED, 5)
    })
  }

  for (const [name, fn] of [
    ['fadeOut', fadeOut],
    ['scaleOut', scaleOut],
  ] as const) {
    it(`${name}: starts from authored alpha, not 1`, () => {
      const tl = gsap.timeline({ paused: true })
      const target = makePixiTarget()
      fn(makeStep({ preset: name }), target, tl, 0)
      tl.progress(0) // start of the tween
      expect(target.proxy.alpha).toBeCloseTo(AUTHORED, 5)
      tl.progress(1)
      expect(target.proxy.alpha).toBeCloseTo(0, 5)
    })
  }
})
