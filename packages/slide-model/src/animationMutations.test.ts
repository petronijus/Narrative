/**
 * animationMutations.test.ts
 *
 * Testy pro animation mutation API:
 * addAnimation, removeAnimation, updateAnimation, reorderAnimations.
 * Idempotence, validace, edge cases.
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
import { yMapToAnimationStep } from './animationBindings.js'
import type { AnimationStep } from '@narrative/shared'

function makeCtx(): AnimationsMutationContext {
  const { doc, slides } = createSlideDoc()
  const dk: SlideMutationContext = { doc, slides }
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideAnimationsCtx(dk, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 animations ctx')
  return ctx
}

function getSnapshots(ctx: AnimationsMutationContext): AnimationStep[] {
  const result: AnimationStep[] = []
  for (let i = 0; i < ctx.animations.length; i++) {
    result.push(yMapToAnimationStep(ctx.animations.get(i)))
  }
  return result
}

const baseStep: Omit<AnimationStep, 'id'> = {
  objectId: 'obj-1',
  preset: 'fadeIn',
  trigger: 'onEnter',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

describe('addAnimation', () => {
  it('přidá animaci do prázdného pole', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, baseStep)

    expect(ctx.animations.length).toBe(1)
    expect(typeof step.id).toBe('string')
    expect(step.id.length).toBeGreaterThan(0)
    expect(step.objectId).toBe('obj-1')
  })

  it('vygeneruje unikátní id pro každé volání', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    expect(s1.id).not.toBe(s2.id)
    expect(ctx.animations.length).toBe(2)
  })

  it('vrácený AnimationStep obsahuje id i všechna pole', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, { ...baseStep, preset: 'slideIn', params: { direction: 'up' } })

    expect(step.preset).toBe('slideIn')
    expect(step.params).toEqual({ direction: 'up' })

    // Ověř že Y.Array obsahuje správná data
    const stored = yMapToAnimationStep(ctx.animations.get(0))
    expect(stored).toEqual(step)
  })
})

describe('removeAnimation', () => {
  it('odstraní existující animaci', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, baseStep)

    removeAnimation(ctx, step.id)

    expect(ctx.animations.length).toBe(0)
  })

  it('no-op + warn pro neexistující id (idempotence)', () => {
    const ctx = makeCtx()
    addAnimation(ctx, baseStep)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    removeAnimation(ctx, 'non-existent-id')

    expect(ctx.animations.length).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("animation with id 'non-existent-id' not found"),
    )
    warnSpy.mockRestore()
  })

  it('odstraní správnou animaci z více', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })
    const s3 = addAnimation(ctx, { ...baseStep, objectId: 'obj-3' })

    removeAnimation(ctx, s2.id)

    expect(ctx.animations.length).toBe(2)
    const snapshots = getSnapshots(ctx)
    expect(snapshots.map((s) => s.id)).toEqual([s1.id, s3.id])
  })
})

describe('updateAnimation', () => {
  it('aktualizuje vlastnosti animace', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, baseStep)

    updateAnimation(ctx, step.id, { duration: 1.5, easing: 'bounce.out' })

    const stored = yMapToAnimationStep(ctx.animations.get(0))
    expect(stored.duration).toBe(1.5)
    expect(stored.easing).toBe('bounce.out')
    // Ostatní fieldy nezměněny
    expect(stored.objectId).toBe('obj-1')
    expect(stored.preset).toBe('fadeIn')
  })

  it('no-op + warn pro neexistující id (idempotence)', () => {
    const ctx = makeCtx()
    addAnimation(ctx, baseStep)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    updateAnimation(ctx, 'non-existent', { duration: 2 })

    // Animace nezměněna
    const stored = yMapToAnimationStep(ctx.animations.get(0))
    expect(stored.duration).toBe(0.5)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("animation with id 'non-existent' not found"),
    )
    warnSpy.mockRestore()
  })

  it('update trigger a preset', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, baseStep)

    updateAnimation(ctx, step.id, { trigger: 'onClick', preset: 'slideIn' })

    const stored = yMapToAnimationStep(ctx.animations.get(0))
    expect(stored.trigger).toBe('onClick')
    expect(stored.preset).toBe('slideIn')
  })

  it('update params', () => {
    const ctx = makeCtx()
    const step = addAnimation(ctx, { ...baseStep, params: { direction: 'up' } })

    updateAnimation(ctx, step.id, { params: { direction: 'down', distance: 50 } })

    const stored = yMapToAnimationStep(ctx.animations.get(0))
    expect(stored.params).toEqual({ direction: 'down', distance: 50 })
  })
})

describe('reorderAnimations', () => {
  it('přeuspořádá animace do nového pořadí', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, { ...baseStep, objectId: 'obj-1' })
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })
    const s3 = addAnimation(ctx, { ...baseStep, objectId: 'obj-3' })

    reorderAnimations(ctx, [s3.id, s1.id, s2.id])

    const snapshots = getSnapshots(ctx)
    expect(snapshots.map((s) => s.id)).toEqual([s3.id, s1.id, s2.id])
    expect(snapshots.map((s) => s.objectId)).toEqual(['obj-3', 'obj-1', 'obj-2'])
  })

  it('zachová data animací po reorder', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, { ...baseStep, duration: 0.5 })
    const s2 = addAnimation(ctx, { ...baseStep, duration: 1.0, preset: 'slideIn' })

    reorderAnimations(ctx, [s2.id, s1.id])

    const snapshots = getSnapshots(ctx)
    const snap0 = snapshots[0]!
    const snap1 = snapshots[1]!
    expect(snap0.duration).toBe(1.0)
    expect(snap0.preset).toBe('slideIn')
    expect(snap1.duration).toBe(0.5)
  })

  it('vyhodí pokud newOrder má jiný počet položek', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    expect(() => reorderAnimations(ctx, [s1.id])).toThrow(
      /newOrder has 1 items but animations has 2/,
    )
  })

  it('vyhodí pokud newOrder obsahuje neznámé id', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    // length souhlasí (2), ale jedno id je neznámé
    expect(() => reorderAnimations(ctx, [s1.id, 'unknown-id'])).toThrow(
      /newOrder contains unknown id 'unknown-id'/,
    )
    void s2
  })

  it('vyhodí pokud newOrder vynechá existující id', () => {
    const ctx = makeCtx()
    const s1 = addAnimation(ctx, baseStep)
    const s2 = addAnimation(ctx, { ...baseStep, objectId: 'obj-2' })

    expect(() => reorderAnimations(ctx, [s1.id, s1.id])).toThrow(
      /existing animation id '.*' missing from newOrder/,
    )
    void s2
  })

  it('prázdný reorder na prázdném poli je no-op', () => {
    const ctx = makeCtx()
    expect(() => reorderAnimations(ctx, [])).not.toThrow()
    expect(ctx.animations.length).toBe(0)
  })
})
