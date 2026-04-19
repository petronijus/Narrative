/**
 * compiler.test.ts
 *
 * DSL → GSAP timeline compile testy.
 * Všechny GSAP volání probíhají přes gsap — testy mockují timeline výstupy.
 * Použitý přístup: real GSAP timeline (paused) + snapshot kontroly přes tl.getChildren().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { compileSteps } from '../compiler.js'
import type {
  AnimationStep,
  AnimationContext,
  PixiTargetHandle,
  DomTargetHandle,
  TargetResolver,
} from '../types.js'
import { createManualInputBridge } from '../inputBridge.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePixiTarget(overrides?: Partial<PixiTargetHandle['proxy']>): PixiTargetHandle {
  const proxy = { x: 0, y: 0, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1, ...overrides }
  const applyMock = vi.fn()
  return {
    kind: 'pixi',
    proxy,
    apply: applyMock,
  }
}

function _makeDomTarget(): DomTargetHandle {
  const element = document.createElement('div')
  return { kind: 'dom', element }
}

function makeResolver(targets: Map<string, PixiTargetHandle | DomTargetHandle>): TargetResolver {
  return {
    resolve: (objectId) => targets.get(objectId) ?? null,
  }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileSteps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('jeden krok fadeIn → timeline má 1 tween', () => {
    const target = makePixiTarget()
    const targets = new Map([['obj1', target as PixiTargetHandle | DomTargetHandle]])
    const ctx: AnimationContext = { targetResolver: makeResolver(targets) }

    const step = makeStep({ id: 'step1', objectId: 'obj1' })
    const { gsapTimeline, dispose } = compileSteps([step], ctx)

    const children = gsapTimeline.getChildren(false)
    expect(children).toHaveLength(1)

    dispose()
  })

  it('dva kroky afterPrevious → sekvenční positioning (duration součet)', () => {
    const t1 = makePixiTarget()
    const t2 = makePixiTarget()
    const targets = new Map<string, PixiTargetHandle | DomTargetHandle>([
      ['obj1', t1],
      ['obj2', t2],
    ])
    const ctx: AnimationContext = { targetResolver: makeResolver(targets) }

    const steps = [
      makeStep({ id: 's1', objectId: 'obj1', duration: 0.5, trigger: 'onEnter' }),
      makeStep({ id: 's2', objectId: 'obj2', duration: 0.5, trigger: 'afterPrevious' }),
    ]

    const { gsapTimeline, dispose } = compileSteps(steps, ctx)

    // Celková duration musí být 1.0s (0.5 + 0.5, sekvenčně)
    expect(gsapTimeline.duration()).toBeCloseTo(1.0, 1)
    dispose()
  })

  it('withPrevious → oba tweeny na stejné pozici (duration = max)', () => {
    const t1 = makePixiTarget()
    const t2 = makePixiTarget()
    const targets = new Map<string, PixiTargetHandle | DomTargetHandle>([
      ['obj1', t1],
      ['obj2', t2],
    ])
    const ctx: AnimationContext = { targetResolver: makeResolver(targets) }

    const steps = [
      makeStep({ id: 's1', objectId: 'obj1', duration: 0.6, trigger: 'onEnter' }),
      makeStep({ id: 's2', objectId: 'obj2', duration: 0.4, trigger: 'withPrevious' }),
    ]

    const { gsapTimeline, dispose } = compileSteps(steps, ctx)

    // Parallel → total duration = max(0.6, 0.4) = 0.6
    expect(gsapTimeline.duration()).toBeCloseTo(0.6, 1)
    dispose()
  })

  it('onClick krok → timeline pausuje po spuštění, advance() pokračuje', async () => {
    const target = makePixiTarget()
    const targets = new Map([['obj1', target as PixiTargetHandle | DomTargetHandle]])
    const bridge = createManualInputBridge()
    const ctx: AnimationContext = {
      targetResolver: makeResolver(targets),
      inputBridge: bridge,
    }

    // Dva kroky: první onEnter, druhý onClick
    const steps = [
      makeStep({ id: 's1', objectId: 'obj1', duration: 0.01, trigger: 'onEnter' }),
      makeStep({ id: 's2', objectId: 'obj1', duration: 0.01, trigger: 'onClick' }),
    ]

    const { gsapTimeline, dispose } = compileSteps(steps, ctx)

    // Spusť a počkej až se pausne na onClick
    gsapTimeline.play()

    // Čekáme na dokončení prvního tweenu (10ms + rezerva)
    await new Promise((r) => setTimeout(r, 50))

    expect(gsapTimeline.paused()).toBe(true)

    // Advance přes InputBridge
    bridge.trigger()
    expect(gsapTimeline.paused()).toBe(false)

    dispose()
  })

  it('null target → step přeskočen, ostatní kroky kompilují', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const target = makePixiTarget()
    const targets = new Map([['existing', target as PixiTargetHandle | DomTargetHandle]])
    const ctx: AnimationContext = { targetResolver: makeResolver(targets) }

    const steps = [
      makeStep({ id: 's1', objectId: 'missing', trigger: 'onEnter' }),
      makeStep({ id: 's2', objectId: 'existing', trigger: 'afterPrevious' }),
    ]

    const { gsapTimeline, dispose } = compileSteps(steps, ctx)

    // Pouze jeden tween (missing byl přeskočen)
    const children = gsapTimeline.getChildren(false)
    expect(children).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("target pro objectId 'missing'"))

    dispose()
    warnSpy.mockRestore()
  })
})
