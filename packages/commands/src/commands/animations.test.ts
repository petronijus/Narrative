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

// The fixture's slide s1: a1 (r1, legacy onEnter, 0.6 s) then a2 (e1, afterPrevious, 0.6 s).
type Timing = { animation: string; start: number; duration: number; trigger: string; delay: number }
const timingOf = (h: Harness) =>
  h
    .run<{ animations: Array<{ id: string; start: number }> }>('query.slide', { slide: 's1' })
    .animations.map((s) => [s.id, s.start])

describe('animation.retime', () => {
  it('places a step at an absolute time after its predecessor', () => {
    const h = harness()
    const out = h.run<{ timing: Timing[] }>('animation.retime', {
      slide: 's1',
      timing: [{ animation: 'a2', start: 2 }],
    })
    expect(steps(h)[1]).toMatchObject({ id: 'a2', trigger: 'afterPrevious', delay: 1.4 })
    expect(out.timing.map((t) => [t.animation, t.start, t.trigger])).toEqual([
      ['a1', 0, 'afterPrevious'],
      ['a2', 2, 'afterPrevious'],
    ])
    expect(timingOf(h)).toEqual([
      ['a1', 0],
      ['a2', 2],
    ])
  })

  it('reorders by time and overlaps with withPrevious', () => {
    const h = harness()
    h.run('animation.retime', {
      slide: 's1',
      timing: [
        { animation: 'a2', start: 0 },
        { animation: 'a1', start: 0.25 },
      ],
    })
    expect(steps(h).map((s) => [s.id, s.trigger, s.delay])).toEqual([
      ['a2', 'afterPrevious', 0],
      ['a1', 'withPrevious', 0.25],
    ])
  })

  it('keeps the start of every step it does not list, re-deriving its trigger', () => {
    const h = harness()
    const { animationId: a3 } = h.run<{ animationId: string }>('animation.add', {
      slide: 's1',
      object: 't1',
      preset: 'fadeIn',
    })
    // a3 starts at 1.2 s; a longer a2 (0.6 → 2.1 s) now overlaps it.
    h.run('animation.retime', { slide: 's1', timing: [{ animation: 'a2', duration: 1.5 }] })
    expect(timingOf(h)).toEqual([
      ['a1', 0],
      ['a2', 0.6],
      [a3, 1.2],
    ])
    expect(steps(h)[2]).toMatchObject({ trigger: 'withPrevious', delay: 0.6 })
    expect(steps(h)[1]!.duration).toBe(1.5)
  })

  it('keeps onClick and starts it no earlier than the previous step ends', () => {
    const h = harness()
    h.run('animation.update', { slide: 's1', animation: 'a2', patch: { trigger: 'onClick' } })
    const out = h.run<{ timing: Timing[] }>('animation.retime', {
      slide: 's1',
      timing: [{ animation: 'a2', start: 0.1 }],
    })
    expect(steps(h)[1]).toMatchObject({ trigger: 'onClick', delay: 0 })
    expect(out.timing[1]).toMatchObject({ animation: 'a2', start: 0.6, trigger: 'onClick' })
  })

  it('times the steps after a pushed onClick step from where it really starts', () => {
    const h = harness()
    h.run('animation.update', { slide: 's1', animation: 'a2', patch: { trigger: 'onClick' } })
    const { animationId: a3 } = h.run<{ animationId: string }>('animation.add', {
      slide: 's1',
      object: 't1',
      preset: 'fadeIn',
    })
    // a2 cannot start before a1 ends (0.6 s); a3 still starts at 0.9 s.
    h.run('animation.retime', {
      slide: 's1',
      timing: [
        { animation: 'a2', start: 0.1 },
        { animation: a3, start: 0.9 },
      ],
    })
    expect(timingOf(h)).toEqual([
      ['a1', 0],
      ['a2', 0.6],
      [a3, 0.9],
    ])
  })

  it('lets a later step overtake an onClick step pushed past it', () => {
    const h = harness()
    h.run('animation.update', { slide: 's1', animation: 'a2', patch: { trigger: 'onClick' } })
    const { animationId: a3 } = h.run<{ animationId: string }>('animation.add', {
      slide: 's1',
      object: 't1',
      preset: 'fadeIn',
    })
    // a3 at 0.3 s overlaps a1; the click step a2 then waits for a3 to end.
    h.run('animation.retime', {
      slide: 's1',
      timing: [
        { animation: 'a2', start: 0.1 },
        { animation: a3, start: 0.3 },
      ],
    })
    expect(timingOf(h)).toEqual([
      ['a1', 0],
      [a3, 0.3],
      ['a2', 0.9],
    ])
    expect(steps(h).map((s) => s.trigger)).toEqual(['afterPrevious', 'withPrevious', 'onClick'])
  })

  it('is idempotent: the same times twice leave the same timeline', () => {
    const h = harness()
    const input = {
      slide: 's1',
      timing: [
        { animation: 'a1', start: 0.3 },
        { animation: 'a2', start: 0.1 },
      ],
    }
    h.run('animation.retime', input)
    const once = listSlides(h.deck)[0]!.animations
    h.run('animation.retime', input)
    expect(listSlides(h.deck)[0]!.animations).toEqual(once)
  })

  it('refuses repeated, unknown and empty entries and waits beyond the step limit', () => {
    const h = harness()
    expect(
      h.fail('animation.retime', {
        slide: 's1',
        timing: [
          { animation: 'a1', start: 1 },
          { animation: 'a1', start: 2 },
        ],
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('animation.retime', { slide: 's1', timing: [{ animation: 'nope', start: 1 }] }).code,
    ).toBe('not_found')
    expect(h.fail('animation.retime', { slide: 's1', timing: [{ animation: 'a1' }] }).code).toBe(
      'invalid_input',
    )
    expect(
      h.fail('animation.retime', { slide: 's1', timing: [{ animation: 'a2', start: 700 }] }).code,
    ).toBe('invalid_input')
  })
})

describe('animation.retarget', () => {
  it('moves steps to another object and keeps their order, timing and params', () => {
    const h = harness()
    h.run('animation.update', {
      slide: 's1',
      animation: 'a2',
      patch: { preset: 'moveTo', params: { targetX: 300, targetY: 200 } },
    })
    const before = steps(h)
    expect(
      h.run('animation.retarget', { slide: 's1', animations: ['a2', 'a1'], object: 't1' }),
    ).toEqual({ retargeted: ['a2', 'a1'] })
    expect(steps(h)).toEqual(before.map((s) => ({ ...s, objectId: 't1' })))
  })

  it('refuses an object on another slide and unknown steps', () => {
    const h = harness()
    expect(
      h.fail('animation.retarget', { slide: 's1', animations: ['a1'], object: 'lock1' }).code,
    ).toBe('not_found')
    expect(
      h.fail('animation.retarget', { slide: 's1', animations: ['nope'], object: 't1' }).code,
    ).toBe('not_found')
  })
})
