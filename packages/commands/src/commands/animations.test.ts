import { describe, expect, it } from 'vitest'
import { listSlides } from '@narrative/slide-model'
import { harness, type Harness } from '../testing/harness.js'

const steps = (h: Harness, slide = 0) => listSlides(h.deck)[slide]!.animations

describe('animation.add', () => {
  it("applies the editor's defaults: afterPrevious, 0.6 s, no delay, power2.out", () => {
    const h = harness()
    const { animationId } = h.run<{ animationId: string }>('animation.add', {
      slide: 's1',
      object: 't1',
      preset: 'popIn',
    })
    expect(steps(h).at(-1)).toEqual({
      id: animationId,
      objectId: 't1',
      preset: 'popIn',
      trigger: 'afterPrevious',
      duration: 0.6,
      delay: 0,
      easing: 'power2.out',
    })
  })

  it('seeds moveTo with the slide centre and rotateTo with 180°, filling only what is missing', () => {
    const h = harness()
    h.run('animation.add', { slide: 's1', object: 'r1', preset: 'moveTo' })
    expect(steps(h).at(-1)!.params).toEqual({ targetX: 960, targetY: 540 })
    h.run('animation.add', {
      slide: 's1',
      object: 'r1',
      preset: 'moveTo',
      params: { targetX: 100 },
    })
    expect(steps(h).at(-1)!.params).toEqual({ targetX: 100, targetY: 540 })
    h.run('animation.add', {
      slide: 's1',
      object: 'r1',
      preset: 'rotateTo',
      trigger: 'withPrevious',
    })
    expect(steps(h).at(-1)).toMatchObject({ trigger: 'withPrevious', params: { angleDeg: 180 } })
  })

  it('validates params per preset, easing names and the target object', () => {
    const h = harness()
    expect(
      h.fail('animation.add', {
        slide: 's1',
        object: 'r1',
        preset: 'fadeIn',
        params: { direction: 'up' },
      }).code,
    ).toBe('invalid_input')
    const e = h.fail('animation.add', {
      slide: 's1',
      object: 'r1',
      preset: 'slideIn',
      params: { direction: 'sideways' },
    })
    expect(e.issues[0]!.path).toEqual(['params', 'direction'])
    expect(
      h.fail('animation.add', {
        slide: 's1',
        object: 'r1',
        preset: 'fadeIn',
        easing: 'power9.wobble',
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('animation.add', { slide: 's1', object: 'r1', preset: 'fadeIn', duration: 0 }).code,
    ).toBe('invalid_input')
    // lock1 lives on s2, not s1.
    expect(h.fail('animation.add', { slide: 's1', object: 'lock1', preset: 'fadeIn' }).code).toBe(
      'not_found',
    )
  })
})

describe('animation.update', () => {
  it('merges params, removes a key with null and changes fields', () => {
    const h = harness()
    h.run('animation.update', {
      slide: 's1',
      animation: 'a1',
      patch: { preset: 'slideIn', params: { direction: 'left', distance: 300 } },
    })
    h.run('animation.update', {
      slide: 's1',
      animation: 'a1',
      patch: { params: { distance: null }, delay: 0.5 },
    })
    expect(steps(h)[0]).toMatchObject({
      preset: 'slideIn',
      delay: 0.5,
      params: { direction: 'left' },
    })
  })

  it('drops params the new preset does not use and fills its defaults', () => {
    const h = harness()
    h.run('animation.update', {
      slide: 's1',
      animation: 'a1',
      patch: { preset: 'slideIn', params: { direction: 'down' } },
    })
    h.run('animation.update', { slide: 's1', animation: 'a1', patch: { preset: 'moveTo' } })
    expect(steps(h)[0]!.params).toEqual({ targetX: 960, targetY: 540 })
    h.run('animation.update', { slide: 's1', animation: 'a1', patch: { preset: 'fadeIn' } })
    expect(steps(h)[0]!.params).toEqual({})
  })

  it('rejects params the preset does not read and unknown steps', () => {
    const h = harness()
    expect(
      h.fail('animation.update', {
        slide: 's1',
        animation: 'a1',
        patch: { params: { fromScale: 2 } },
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('animation.update', { slide: 's1', animation: 'zz', patch: { delay: 1 } }).code,
    ).toBe('not_found')
    expect(h.fail('animation.update', { slide: 's1', animation: 'a1', patch: {} }).code).toBe(
      'invalid_input',
    )
  })
})

describe('animation.remove / animation.reorder', () => {
  it('reorders by a full permutation only', () => {
    const h = harness()
    expect(h.run('animation.reorder', { slide: 's1', order: ['a2', 'a1'] })).toEqual({
      order: ['a2', 'a1'],
    })
    expect(steps(h).map((s) => s.id)).toEqual(['a2', 'a1'])
    expect(h.fail('animation.reorder', { slide: 's1', order: ['a1'] }).code).toBe('conflict')
    expect(h.fail('animation.reorder', { slide: 's1', order: ['a1', 'a1'] }).code).toBe('conflict')
    expect(h.fail('animation.reorder', { slide: 's1', order: ['a1', 'nope'] }).code).toBe(
      'not_found',
    )
  })

  it('removes steps and leaves the objects', () => {
    const h = harness()
    h.run('animation.remove', { slide: 's1', animations: ['a1'] })
    expect(steps(h).map((s) => s.id)).toEqual(['a2'])
    expect(listSlides(h.deck)[0]!.objects.map((o) => o.id)).toContain('r1')
  })
})

describe('triggers', () => {
  it('refuses the legacy onEnter trigger for new and changed steps', () => {
    const h = harness()
    expect(
      h.fail('animation.add', { slide: 's1', object: 't1', preset: 'fadeIn', trigger: 'onEnter' })
        .code,
    ).toBe('invalid_input')
    expect(
      h.fail('animation.update', { slide: 's1', animation: 'a2', patch: { trigger: 'onEnter' } })
        .code,
    ).toBe('invalid_input')
  })

  it('keeps a stored onEnter when an update does not touch the trigger, and reads it back', () => {
    const h = harness()
    // a1 is a legacy onEnter step in the fixture.
    h.run('animation.update', {
      slide: 's1',
      animation: 'a1',
      patch: { duration: 1.5, easing: 'none' },
    })
    expect(steps(h)[0]).toMatchObject({
      id: 'a1',
      trigger: 'onEnter',
      duration: 1.5,
      easing: 'none',
    })
    const read = h.run<{ animations: Array<{ id: string; trigger: string }> }>('query.slide', {
      slide: 's1',
    })
    expect(read.animations.find((s) => s.id === 'a1')!.trigger).toBe('onEnter')
  })

  it('replaces onEnter with an offered trigger', () => {
    const h = harness()
    for (const trigger of ['withPrevious', 'onClick', 'afterPrevious'] as const) {
      h.run('animation.update', { slide: 's1', animation: 'a1', patch: { trigger } })
      expect(steps(h)[0]!.trigger).toBe(trigger)
    }
  })
})
