/**
 * presets/expansion.test.ts
 *
 * Smoke tests for every preset added in M15. Each preset must:
 *   1. Be resolvable via getPresetFactory(preset).
 *   2. Insert exactly one tween into the provided timeline for a Pixi target.
 *   3. Drive the target.apply callback via onUpdate on a Pixi target.
 *   4. Insert exactly one tween for a DOM target.
 *   5. Respect step.duration (timeline duration matches within 0.1 s).
 *
 * Keep this file cheap — detailed per-preset behaviour (param resolution,
 * easing defaults, from/to states) has its own test file when it's worth
 * the coverage. fadeIn / slideIn already have bespoke tests.
 */

import { describe, it, expect, vi } from 'vitest'
import { gsap } from 'gsap'
import { getPresetFactory } from '../../presets/index.js'
import type { AnimationStep, PixiTargetHandle, DomTargetHandle } from '../../types.js'
import type { AnimationPreset } from '@narrative/shared'

function makeStep(preset: AnimationPreset, overrides?: Partial<AnimationStep>): AnimationStep {
  return {
    id: 'test-step',
    objectId: 'obj1',
    preset,
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: '',
    ...overrides,
  }
}

function makePixiTarget(): PixiTargetHandle {
  const proxy = { x: 10, y: 20, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 }
  return { kind: 'pixi', proxy, apply: vi.fn() }
}

function makeDomTarget(): DomTargetHandle {
  return { kind: 'dom', element: document.createElement('div') }
}

const NEW_PRESETS: AnimationPreset[] = [
  'fadeOut',
  'slideOut',
  'scaleIn',
  'scaleOut',
  'zoomIn',
  'rotateIn',
  'bounceIn',
  'flipIn',
  'popIn',
  'dissolveIn',
  'wipeIn',
]

describe('M15 preset expansion — smoke', () => {
  for (const preset of NEW_PRESETS) {
    describe(preset, () => {
      it('is registered', () => {
        expect(getPresetFactory(preset)).not.toBeNull()
      })

      it('Pixi target: inserts a single tween that fires apply via onUpdate', () => {
        const tl = gsap.timeline({ paused: true })
        const target = makePixiTarget()
        const step = makeStep(preset, { duration: 0.01 })
        const factory = getPresetFactory(preset)!
        factory(step, target, tl, 0)

        expect(tl.getChildren(false)).toHaveLength(1)
        tl.seek(0.005)
        expect(target.apply).toHaveBeenCalled()
      })

      it('DOM target: inserts a single tween on the element', () => {
        const tl = gsap.timeline({ paused: true })
        const target = makeDomTarget()
        const step = makeStep(preset)
        const factory = getPresetFactory(preset)!
        factory(step, target, tl, 0)

        const children = tl.getChildren(false)
        expect(children).toHaveLength(1)
        expect((children[0] as gsap.core.Tween).targets()).toContain(target.element)
      })

      it('respects duration', () => {
        const tl = gsap.timeline({ paused: true })
        const target = makePixiTarget()
        const step = makeStep(preset, { duration: 1.1 })
        const factory = getPresetFactory(preset)!
        factory(step, target, tl, 0)
        expect(tl.duration()).toBeCloseTo(1.1, 1)
      })
    })
  }
})
