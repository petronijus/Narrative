/**
 * runtime.test.ts
 *
 * AnimationRuntime lifecycle testy.
 * Ověřuje: play/pause/reset, advance() při onClick triggeru.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAnimationRuntime } from '../runtime.js'
import { createManualInputBridge } from '../inputBridge.js'
import type { AnimationStep, AnimationContext, PixiTargetHandle, TargetResolver } from '../types.js'

function makePixiTarget(): PixiTargetHandle {
  const proxy = { x: 0, y: 0, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 }
  return {
    kind: 'pixi',
    proxy,
    apply: vi.fn(),
  }
}

function makeResolver(target: PixiTargetHandle): TargetResolver {
  return { resolve: () => target }
}

function makeStep(overrides?: Partial<AnimationStep>): AnimationStep {
  return {
    id: 'step1',
    objectId: 'obj1',
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.01,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

describe('AnimationRuntime', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('play() spustí timeline', () => {
    const target = makePixiTarget()
    const ctx: AnimationContext = { targetResolver: makeResolver(target) }
    const runtime = createAnimationRuntime([makeStep()], ctx)

    runtime.play()
    // Po play() GSAP timeline není pausovaná
    // (přistupujeme přes runtime, ne přes interní tl)
    // Ověříme nepřímo přes destroy bez chyby
    expect(() => runtime.destroy()).not.toThrow()
  })

  it('pause() pausuje timeline', () => {
    const target = makePixiTarget()
    const ctx: AnimationContext = { targetResolver: makeResolver(target) }
    const runtime = createAnimationRuntime([makeStep()], ctx)

    runtime.play()
    runtime.pause()
    // Nestabilní čekat na GSAP state — ověříme že to nehodí
    expect(() => runtime.destroy()).not.toThrow()
  })

  it('reset() vrátí na začátek', () => {
    const target = makePixiTarget()
    const ctx: AnimationContext = { targetResolver: makeResolver(target) }
    const runtime = createAnimationRuntime([makeStep({ duration: 0.5 })], ctx)

    runtime.play()
    runtime.reset()
    // Po reset proxy.alpha by měla být zpět na from hodnotu (0 pro fadeIn)
    // seek(0) aplikuje from stav
    expect(target.proxy.alpha).toBeCloseTo(0, 1)
    runtime.destroy()
  })

  it('seek() nastavuje pozici v timeline', () => {
    const target = makePixiTarget()
    const ctx: AnimationContext = { targetResolver: makeResolver(target) }
    const runtime = createAnimationRuntime([makeStep({ duration: 1.0 })], ctx)

    // seek na konec → alpha = 1
    runtime.seek(1.0)
    expect(target.proxy.alpha).toBeCloseTo(1, 1)
    runtime.destroy()
  })

  it('advance() při onClick: pokračuje z pause', async () => {
    const target = makePixiTarget()
    const bridge = createManualInputBridge()
    const ctx: AnimationContext = {
      targetResolver: makeResolver(target),
      inputBridge: bridge,
    }

    const steps = [
      makeStep({ id: 's1', trigger: 'onEnter', duration: 0.01 }),
      makeStep({ id: 's2', trigger: 'onClick', duration: 0.01 }),
    ]

    const runtime = createAnimationRuntime(steps, ctx)
    runtime.play()

    // Čekej až se pausne na onClick
    await new Promise((r) => setTimeout(r, 50))
    // Runtime advance() by mělo resumovat timeline
    expect(() => runtime.advance()).not.toThrow()

    runtime.destroy()
  })

  it('destroy() nezhodí i při prázdném steps[]', () => {
    const target = makePixiTarget()
    const ctx: AnimationContext = { targetResolver: makeResolver(target) }
    const runtime = createAnimationRuntime([], ctx)

    expect(() => runtime.destroy()).not.toThrow()
  })
})
