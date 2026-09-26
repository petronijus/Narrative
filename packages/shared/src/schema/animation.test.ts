import { describe, expect, it } from 'vitest'
import type { AnimationPreset, AnimationStep } from '../animation.js'
import { AnimationStepSchema, ANIMATION_PRESET_PARAMS_SCHEMAS, EasingSchema } from './animation.js'

function step(over: Partial<AnimationStep> = {}): AnimationStep {
  return {
    id: 'st1',
    objectId: 'o1',
    preset: 'fadeIn',
    trigger: 'onClick',
    duration: 0.6,
    delay: 0,
    easing: 'power2.out',
    ...over,
  }
}

function paths(input: unknown): PropertyKey[][] {
  return (AnimationStepSchema.safeParse(input).error?.issues ?? []).map((i) => i.path)
}

describe('AnimationStepSchema — per-preset params', () => {
  const valid: Array<[AnimationPreset, Record<string, unknown> | undefined]> = [
    ['fadeIn', undefined],
    ['fadeOut', { repeat: 2 }],
    ['slideIn', { direction: 'left', distance: 200 }],
    ['slideOut', { direction: 'down' }],
    ['scaleIn', {}],
    ['scaleOut', undefined],
    ['zoomIn', { fromScale: 1.5 }],
    ['rotateIn', { angle: -Math.PI }],
    ['bounceIn', undefined],
    ['flipIn', { axis: 'y' }],
    ['popIn', { repeat: 0 }],
    ['dissolveIn', undefined],
    ['wipeIn', { direction: 'up' }],
    ['moveTo', { targetX: 1200, targetY: 700 }],
    ['rotateTo', { angleDeg: 90 }],
  ]

  it('has a params schema for every preset', () => {
    expect(Object.keys(ANIMATION_PRESET_PARAMS_SCHEMAS).sort()).toEqual(
      valid.map(([p]) => p).sort(),
    )
  })

  it.each(valid)('%s with %j parses unchanged', (preset, params) => {
    const s = step({ preset, ...(params !== undefined ? { params } : {}) })
    expect(AnimationStepSchema.parse(s)).toEqual(s)
  })

  it.each([
    ['slideIn', { direction: 'diagonal' }, ['params', 'direction']],
    ['slideIn', { distance: -10 }, ['params', 'distance']],
    ['zoomIn', { fromScale: 0 }, ['params', 'fromScale']],
    ['flipIn', { axis: 'z' }, ['params', 'axis']],
    ['rotateTo', { angleDeg: '90' }, ['params', 'angleDeg']],
    ['fadeIn', { repeat: 21 }, ['params', 'repeat']],
    ['fadeIn', { repeat: -1 }, ['params', 'repeat']], // GSAP "forever"
    ['fadeIn', { repeat: 1.5 }, ['params', 'repeat']],
  ] as const)('%s rejects %j at %j', (preset, params, path) => {
    expect(paths(step({ preset, params }))).toEqual([path])
  })

  it('rejects a param meant for another preset, naming the preset', () => {
    const r = AnimationStepSchema.safeParse(step({ preset: 'fadeIn', params: { direction: 'up' } }))
    expect(r.error?.issues).toHaveLength(1)
    expect(r.error?.issues[0]?.path).toEqual(['params'])
    expect(r.error?.issues[0]?.message).toMatch(/^fadeIn: .*direction/)
  })

  it('requires both moveTo targets', () => {
    expect(paths(step({ preset: 'moveTo' }))).toEqual([
      ['params', 'targetX'],
      ['params', 'targetY'],
    ])
    expect(paths(step({ preset: 'moveTo', params: { targetX: 5 } }))).toEqual([
      ['params', 'targetY'],
    ])
  })
})

describe('AnimationStepSchema — timing clamps mirrored from the compiler', () => {
  it.each([
    [{ duration: 0 }, ['duration']],
    [{ duration: 600.5 }, ['duration']],
    [{ delay: -0.1 }, ['delay']],
    [{ delay: 601 }, ['delay']],
    [{ duration: Number.POSITIVE_INFINITY }, ['duration']],
  ])('rejects %j', (over, path) => {
    expect(paths(step(over))).toEqual([path])
  })

  it('accepts the bounds themselves', () => {
    expect(AnimationStepSchema.safeParse(step({ duration: 600, delay: 600 })).success).toBe(true)
  })

  it('rejects empty ids, unknown presets/triggers and unknown keys', () => {
    expect(paths(step({ objectId: '' }))).toEqual([['objectId']])
    expect(paths({ ...step(), preset: 'spin' })).toEqual([['preset']])
    expect(paths({ ...step(), trigger: 'onHover' })).toEqual([['trigger']])
    expect(AnimationStepSchema.safeParse({ ...step(), loop: true }).success).toBe(false)
  })
})

describe('EasingSchema', () => {
  it.each([
    'none',
    'linear',
    'power1.out',
    'power2.inOut',
    'power3.inOut',
    'sine.inOut',
    'back.out',
    'back.out(1.7)',
    'bounce.out',
    'elastic.out',
    'elastic.inOut(1, 0.3)',
    'expo.in',
    'quad',
    'steps(5)',
  ])('accepts %j', (e) => {
    expect(EasingSchema.safeParse(e).success).toBe(true)
  })

  it.each([
    '',
    'power5.out',
    'bouncy',
    'sine.out(2)',
    'power2.outIn',
    'steps(x)',
    'Power2.easeOut',
  ])('rejects %j', (e) => {
    expect(EasingSchema.safeParse(e).success).toBe(false)
  })
})
