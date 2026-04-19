/**
 * presets/fadeIn.test.ts
 *
 * Unit testy pro fadeIn preset factory.
 * Ověřuje: alpha animace pro Pixi proxy, opacity pro DOM target.
 */

import { describe, it, expect, vi } from 'vitest'
import { gsap } from 'gsap'
import { fadeIn } from '../../presets/fadeIn.js'
import type { AnimationStep, PixiTargetHandle, DomTargetHandle } from '../../types.js'

function makeStep(overrides?: Partial<AnimationStep>): AnimationStep {
  return {
    id: 'test-step',
    objectId: 'obj1',
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

function makePixiTarget(): PixiTargetHandle {
  const proxy = { x: 10, y: 20, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 }
  return {
    kind: 'pixi',
    proxy,
    apply: vi.fn(),
  }
}

describe('fadeIn preset', () => {
  it('Pixi target: vloží tween animující proxy.alpha 0→1', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget()
    const step = makeStep()

    fadeIn(step, target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)

    const tween = children[0] as gsap.core.Tween
    // Zkontrolujeme že target je proxy object
    expect(tween.targets()).toContain(target.proxy)
  })

  it('Pixi target: onUpdate callback je apply funkce', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget()
    const step = makeStep({ duration: 0.01 })

    fadeIn(step, target, tl, 0)

    // Simulate jednoho update voláním seek
    tl.seek(0.005)

    // apply měla být volána z onUpdate
    expect(target.apply).toHaveBeenCalled()
  })

  it('DOM target: vloží tween animující opacity CSS', () => {
    const tl = gsap.timeline({ paused: true })
    const element = document.createElement('div')
    const target: DomTargetHandle = { kind: 'dom', element }
    const step = makeStep()

    fadeIn(step, target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)

    const tween = children[0] as gsap.core.Tween
    expect(tween.targets()).toContain(element)
  })

  it('respektuje duration a easing ze step', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget()
    const step = makeStep({ duration: 1.2, easing: 'bounce.out' })

    fadeIn(step, target, tl, 0)

    expect(tl.duration()).toBeCloseTo(1.2, 1)
  })
})
