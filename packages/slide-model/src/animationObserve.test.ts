/**
 * animationObserve.test.ts
 *
 * Testy pro subscribeToAnimations observer.
 * Full snapshot pattern — test synchronní initial emission + on-change + unsubscribe.
 */

import { describe, it, expect, vi } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import {
  addAnimation,
  removeAnimation,
  updateAnimation,
  reorderAnimations,
  type AnimationsMutationContext,
} from './animationMutations.js'
import { getSlideAnimationsCtx } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import { subscribeToAnimations } from './animationObserve.js'
import type { AnimationStep } from '@narrative/shared'

function makeCtx(): AnimationsMutationContext {
  const { doc, slides } = createSlideDoc()
  const dk: SlideMutationContext = { doc, slides }
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideAnimationsCtx(dk, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 animations ctx')
  return ctx
}

const baseStep: Omit<AnimationStep, 'id'> = {
  objectId: 'obj-1',
  preset: 'fadeIn',
  trigger: 'onEnter',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

describe('subscribeToAnimations — initial emission', () => {
  it('zavolá callback ihned s prázdným polem (prázdný doc)', () => {
    const ctx = makeCtx()
    const cb = vi.fn()

    subscribeToAnimations(ctx, cb)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith([])
  })

  it('zavolá callback ihned se současnými animacemi', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    const cb = vi.fn()
    subscribeToAnimations(ctx, cb)

    expect(cb).toHaveBeenCalledTimes(1)
    const received = cb.mock.calls[0]![0] as AnimationStep[]
    expect(received).toHaveLength(2)
    expect(received[0]!.id).toBe(s1.id)
    expect(received[1]!.id).toBe(s2.id)
  })
})

describe('subscribeToAnimations — on-change', () => {
  it('emituje nový snapshot po addAnimation', () => {
    const ctx = makeCtx()
    const calls: AnimationStep[][] = []
    subscribeToAnimations(ctx, (a) => calls.push(a))

    // Initial = 1 call
    expect(calls).toHaveLength(1)

    addAnimation(ctx, baseStep)

    expect(calls).toHaveLength(2)
    expect(calls[1]!).toHaveLength(1)
    expect(calls[1]![0]!.objectId).toBe('obj-1')
  })

  it('emituje nový snapshot po removeAnimation', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)

    const calls: AnimationStep[][] = []
    subscribeToAnimations(ctx, (a) => calls.push(a))

    removeAnimation(ctx, s1.id)

    expect(calls).toHaveLength(2)
    expect(calls[1]!).toHaveLength(0)
  })

  it('emituje nový snapshot po updateAnimation', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)

    const calls: AnimationStep[][] = []
    subscribeToAnimations(ctx, (a) => calls.push(a))

    updateAnimation(ctx, s1.id, { duration: 2.0 })

    expect(calls).toHaveLength(2)
    expect(calls[1]![0]!.duration).toBe(2.0)
  })

  it('emituje nový snapshot po reorderAnimations', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, { ...baseStep, objectId: 'obj-1' })
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    const calls: AnimationStep[][] = []
    subscribeToAnimations(ctx, (a) => calls.push(a))

    reorderAnimations(ctx, [s2.id, s1.id])

    expect(calls).toHaveLength(2)
    expect(calls[1]![0]!.id).toBe(s2.id)
    expect(calls[1]![1]!.id).toBe(s1.id)
  })
})

describe('subscribeToAnimations — unsubscribe', () => {
  it('unsubscribe zastaví emitování po dalších změnách', () => {
    const ctx = makeCtx()
    const cb = vi.fn()

    const unsubscribe = subscribeToAnimations(ctx, cb)
    expect(cb).toHaveBeenCalledTimes(1) // initial

    unsubscribe()

    addAnimation(ctx, baseStep)

    // Žádný nový callback po unsubscribe
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('více subscriberů je nezávislých', () => {
    const ctx = makeCtx()
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    const unsub1 = subscribeToAnimations(ctx, cb1)
    subscribeToAnimations(ctx, cb2)

    addAnimation(ctx, baseStep)

    expect(cb1).toHaveBeenCalledTimes(2)
    expect(cb2).toHaveBeenCalledTimes(2)

    unsub1()
    addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    expect(cb1).toHaveBeenCalledTimes(2) // zastaveno
    expect(cb2).toHaveBeenCalledTimes(3) // stále běží
  })
})
