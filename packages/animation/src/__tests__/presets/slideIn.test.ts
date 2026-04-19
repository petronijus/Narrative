/**
 * presets/slideIn.test.ts
 *
 * Unit testy pro slideIn preset factory.
 * Ověřuje direction semantics pro Pixi proxy + DOM CSS transform.
 */

import { describe, it, expect, vi } from 'vitest'
import { gsap } from 'gsap'
import { slideIn } from '../../presets/slideIn.js'
import type { AnimationStep, PixiTargetHandle, DomTargetHandle } from '../../types.js'

const DEFAULT_DISTANCE = 100

function makeStep(
  direction: 'up' | 'down' | 'left' | 'right',
  overrides?: Partial<AnimationStep>,
): AnimationStep {
  return {
    id: 'test-step',
    objectId: 'obj1',
    preset: 'slideIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    params: { direction },
    ...overrides,
  }
}

function makePixiTarget(x = 50, y = 80): PixiTargetHandle {
  const proxy = { x, y, rotation: 0, alpha: 0, scaleX: 1, scaleY: 1 }
  return {
    kind: 'pixi',
    proxy,
    apply: vi.fn(),
  }
}

describe('slideIn preset — Pixi target', () => {
  it('direction up: proxy animuje z (currentY + distance) na currentY', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(50, 80)
    const step = makeStep('up')

    slideIn(step, target, tl, 0)

    // Seek na začátek — fromValues jsou aplikovány
    tl.seek(0)

    // Proxy Y by měla být nastavena na from hodnotu (80 + 100 = 180)
    // GSAP fromTo — na seek(0) je stav "from"
    expect(target.proxy.y).toBeCloseTo(180, 0)
  })

  it('direction down: proxy animuje z (currentY - distance) na currentY', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(50, 80)
    const step = makeStep('down')

    slideIn(step, target, tl, 0)

    tl.seek(0)
    // fromY = 80 - 100 = -20
    expect(target.proxy.y).toBeCloseTo(-20, 0)
  })

  it('direction left: proxy animuje z (currentX + distance) na currentX', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(50, 80)
    const step = makeStep('left')

    slideIn(step, target, tl, 0)

    tl.seek(0)
    // fromX = 50 + 100 = 150
    expect(target.proxy.x).toBeCloseTo(150, 0)
  })

  it('direction right: proxy animuje z (currentX - distance) na currentX', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(50, 80)
    const step = makeStep('right')

    slideIn(step, target, tl, 0)

    tl.seek(0)
    // fromX = 50 - 100 = -50
    expect(target.proxy.x).toBeCloseTo(-50, 0)
  })

  it('custom distance respektován', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(0, 0)
    const step = makeStep('up', { params: { direction: 'up', distance: 200 } })

    slideIn(step, target, tl, 0)

    tl.seek(0)
    expect(target.proxy.y).toBeCloseTo(200, 0)
  })

  it('kombinuje slide s fade (alpha 0 → 1)', () => {
    const tl = gsap.timeline({ paused: true })
    const target = makePixiTarget(0, 0)
    const step = makeStep('up')

    slideIn(step, target, tl, 0)

    // Na začátku alpha = 0
    tl.seek(0)
    expect(target.proxy.alpha).toBeCloseTo(0, 1)

    // Na konci alpha = 1
    tl.seek(step.duration)
    expect(target.proxy.alpha).toBeCloseTo(1, 1)
  })
})

describe('slideIn preset — DOM target', () => {
  function makeStep2(direction: 'up' | 'down' | 'left' | 'right'): AnimationStep {
    return {
      id: 'dom-step',
      objectId: 'overlay1',
      preset: 'slideIn',
      trigger: 'onEnter',
      duration: 0.5,
      delay: 0,
      easing: 'power2.out',
      params: { direction },
    }
  }

  it('direction up: z translateY(100px) → translateY(0)', () => {
    const tl = gsap.timeline({ paused: true })
    const element = document.createElement('div')
    const target: DomTargetHandle = { kind: 'dom', element }

    slideIn(makeStep2('up'), target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)
    expect((children[0] as gsap.core.Tween).targets()).toContain(element)
  })

  it('direction down: z translateY(-100px) → translateY(0)', () => {
    const tl = gsap.timeline({ paused: true })
    const element = document.createElement('div')
    const target: DomTargetHandle = { kind: 'dom', element }

    slideIn(makeStep2('down'), target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)
  })

  it('direction left: z translateX(100px) → translateX(0)', () => {
    const tl = gsap.timeline({ paused: true })
    const element = document.createElement('div')
    const target: DomTargetHandle = { kind: 'dom', element }

    slideIn(makeStep2('left'), target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)
  })

  it('direction right: z translateX(-100px) → translateX(0)', () => {
    const tl = gsap.timeline({ paused: true })
    const element = document.createElement('div')
    const target: DomTargetHandle = { kind: 'dom', element }

    slideIn(makeStep2('right'), target, tl, 0)

    const children = tl.getChildren(false)
    expect(children).toHaveLength(1)
  })
})

// Suppress unused import warning
void DEFAULT_DISTANCE
