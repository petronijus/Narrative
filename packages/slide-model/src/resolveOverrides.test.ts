/**
 * resolveOverrides.test.ts — M16 P7
 *
 * Pure-function tests for the override resolver. No Yjs, no React.
 */

import { describe, it, expect } from 'vitest'
import type {
  RectangleObject,
  TextObject,
  AnimationStep,
  ComponentInstanceOverrides,
  LeafOverridePayload,
} from '@narrative/shared'
import { resolveInstanceTree, resolveInstanceAnimations } from './resolveOverrides.js'

function makeRect(id: string, overrides: Partial<RectangleObject> = {}): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    fill: 0xff0000,
    rotation: 0,
    opacity: 1,
    ...overrides,
  }
}

function makeText(id: string, overrides: Partial<TextObject> = {}): TextObject {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 40,
    rotation: 0,
    opacity: 1,
    text: 'master text',
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
    ...overrides,
  }
}

function makeStep(id: string, overrides: Partial<AnimationStep> = {}): AnimationStep {
  return {
    id,
    objectId: 'obj-1',
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveInstanceTree
// ---------------------------------------------------------------------------

describe('resolveInstanceTree', () => {
  it('returns shallow copy when overrides is undefined', () => {
    const master = [makeRect('a'), makeRect('b')]
    const out = resolveInstanceTree(master, undefined)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(master[0])
    expect(out[1]).toBe(master[1])
    // Different array identity so callers can mutate freely.
    expect(out).not.toBe(master)
  })

  it('returns shallow copy when overrides has no leaves', () => {
    const master = [makeRect('a')]
    const out = resolveInstanceTree(master, {})
    expect(out[0]).toBe(master[0])
  })

  it('overrides text on text leaves', () => {
    const master = [makeText('t1', { text: 'master' })]
    const overrides: ComponentInstanceOverrides = {
      leaves: { t1: { text: 'overridden' } },
    }
    const out = resolveInstanceTree(master, overrides)
    expect(out[0]).not.toBe(master[0])
    expect((out[0] as TextObject).text).toBe('overridden')
    // Master untouched.
    expect((master[0] as TextObject).text).toBe('master')
  })

  it('overrides fill (number)', () => {
    const master = [makeRect('r1', { fill: 0xff0000 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { fill: 0x00ff00 } },
    })
    expect((out[0] as RectangleObject).fill).toBe(0x00ff00)
  })

  it('overrides fill with TokenRef', () => {
    const master = [makeRect('r1', { fill: 0xff0000 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { fill: { $token: 'colors.brand' } } },
    })
    expect((out[0] as RectangleObject).fill).toEqual({ $token: 'colors.brand' })
  })

  it('overrides stroke', () => {
    const master = [makeRect('r1')]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { stroke: 0x123456 } },
    })
    expect((out[0] as RectangleObject).stroke).toBe(0x123456)
  })

  it('transform override is additive on x/y', () => {
    const master = [makeRect('r1', { x: 10, y: 20 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { transform: { x: 5, y: -3 } } },
    })
    expect(out[0]!.x).toBe(15)
    expect(out[0]!.y).toBe(17)
  })

  it('transform override only-x leaves y untouched', () => {
    const master = [makeRect('r1', { x: 10, y: 20 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { transform: { x: 5 } } },
    })
    expect(out[0]!.x).toBe(15)
    expect(out[0]!.y).toBe(20)
  })

  it('passes through master nodes that have no override', () => {
    const master = [makeRect('a'), makeRect('b'), makeRect('c')]
    const out = resolveInstanceTree(master, {
      leaves: { b: { fill: 0x00ff00 } },
    })
    expect(out[0]).toBe(master[0])
    expect(out[1]).not.toBe(master[1])
    expect(out[2]).toBe(master[2])
  })

  it('skips overrides with dangling leaf ids without mutating input', () => {
    const master = [makeRect('a')]
    const overrides: ComponentInstanceOverrides = {
      leaves: {
        a: { fill: 0x00ff00 },
        ghost: { fill: 0x0000ff },
      },
    }
    const out = resolveInstanceTree(master, overrides)
    expect(out).toHaveLength(1)
    expect((out[0] as RectangleObject).fill).toBe(0x00ff00)
    // Dangling override preserved on the input — caller may re-add the leaf later.
    expect(overrides.leaves!['ghost']).toEqual({ fill: 0x0000ff })
  })

  it('returns identity for a leaf when override patch produces no field changes', () => {
    const master = [makeRect('r1')]
    const out = resolveInstanceTree(master, {
      // Empty patch should not allocate a new object.
      leaves: { r1: {} },
    })
    expect(out[0]).toBe(master[0])
  })

  it('overrides rotation', () => {
    const master = [makeRect('r1', { rotation: 0 })]
    const out = resolveInstanceTree(master, { leaves: { r1: { rotation: 45 } } })
    expect(out[0]!.rotation).toBe(45)
    expect(master[0]!.rotation).toBe(0) // master untouched
  })

  it('overrides opacity', () => {
    const master = [makeRect('r1', { opacity: 1 })]
    const out = resolveInstanceTree(master, { leaves: { r1: { opacity: 0.4 } } })
    expect(out[0]!.opacity).toBe(0.4)
  })

  it('overrides fontSize and fontWeight on text leaves', () => {
    const master = [makeText('t1', { fontSize: 24, fontWeight: 'normal' })]
    const out = resolveInstanceTree(master, {
      leaves: { t1: { fontSize: 36, fontWeight: 'bold' } },
    })
    const t = out[0] as TextObject
    expect(t.fontSize).toBe(36)
    expect(t.fontWeight).toBe('bold')
    expect((master[0] as TextObject).fontSize).toBe(24) // master untouched
  })

  it('overrides cornerRadius', () => {
    const master = [makeRect('r1')]
    const out = resolveInstanceTree(master, { leaves: { r1: { cornerRadius: 12 } } })
    expect((out[0] as RectangleObject).cornerRadius).toBe(12)
  })

  it('overrides fillStyle as atomic sub-object', () => {
    const master = [makeRect('r1')]
    const fillStyle = {
      kind: 'linearGradient' as const,
      stops: [
        { offset: 0, color: 0xff0000 },
        { offset: 1, color: 0x0000ff },
      ],
      angleDeg: 90,
    }
    const out = resolveInstanceTree(master, { leaves: { r1: { fillStyle } } })
    expect((out[0] as RectangleObject).fillStyle).toEqual(fillStyle)
  })

  it('overrides assetId', () => {
    const master = [makeRect('r1')]
    const out = resolveInstanceTree(master, { leaves: { r1: { assetId: 'asset-xyz' } } })
    expect((out[0] as unknown as { assetId: string }).assetId).toBe('asset-xyz')
  })

  it('absolute x/y override replaces master position', () => {
    const master = [makeRect('r1', { x: 10, y: 20 })]
    const out = resolveInstanceTree(master, { leaves: { r1: { x: 99, y: 88 } } })
    expect(out[0]!.x).toBe(99)
    expect(out[0]!.y).toBe(88)
  })

  it('absolute x wins over transform.x in the same patch', () => {
    // When both absolute x and additive transform.x are in the same patch,
    // the absolute x takes precedence.
    const master = [makeRect('r1', { x: 10, y: 20 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { x: 50, transform: { x: 5 } } },
    })
    // x=50 (absolute), transform.x=5 ignored for x since absolute is present
    expect(out[0]!.x).toBe(50)
    // y has no absolute override so transform.y would apply if set; here not set
    expect(out[0]!.y).toBe(20)
  })

  it('absolute y wins over transform.y in the same patch', () => {
    const master = [makeRect('r1', { x: 10, y: 20 })]
    const out = resolveInstanceTree(master, {
      leaves: { r1: { y: 100, transform: { x: 5, y: 99 } } },
    })
    // x: no absolute override → additive: 10 + 5 = 15
    expect(out[0]!.x).toBe(15)
    // y: absolute 100 wins over additive transform.y=99
    expect(out[0]!.y).toBe(100)
  })

  it('text override does not apply to a non-text leaf (fail-safe)', () => {
    // A rectangle doesn't have a `text` field. The override is silently skipped.
    const master = [makeRect('r1')]
    // Cast via unknown to bypass type-checker for this defensive test
    const patch = { text: 'oops' } as unknown as LeafOverridePayload
    const out = resolveInstanceTree(master, { leaves: { r1: patch } })
    // Master and output should be identical (no text field on rect)
    expect(out[0]).toBe(master[0])
  })
})

// ---------------------------------------------------------------------------
// resolveInstanceAnimations
// ---------------------------------------------------------------------------

describe('resolveInstanceAnimations', () => {
  it('returns shallow copy when overrides is undefined', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const out = resolveInstanceAnimations(steps, undefined)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(steps[0])
  })

  it('drops disabled steps', () => {
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const out = resolveInstanceAnimations(steps, {
      animations: { s2: { disabled: true } },
    })
    expect(out.map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('overrides trigger', () => {
    const steps = [makeStep('s1', { trigger: 'onEnter' })]
    const out = resolveInstanceAnimations(steps, {
      animations: { s1: { trigger: 'onClick' } },
    })
    expect(out[0]!.trigger).toBe('onClick')
  })

  it('ignores invalid trigger string', () => {
    const steps = [makeStep('s1', { trigger: 'onEnter' })]
    const out = resolveInstanceAnimations(steps, {
      animations: { s1: { trigger: 'bogus-trigger' } },
    })
    expect(out[0]!.trigger).toBe('onEnter')
  })

  it('overrides delay / duration / ease', () => {
    const steps = [makeStep('s1', { delay: 0, duration: 0.5, easing: 'power2.out' })]
    const out = resolveInstanceAnimations(steps, {
      animations: { s1: { delay: 1, duration: 2, ease: 'sine.inOut' } },
    })
    expect(out[0]!.delay).toBe(1)
    expect(out[0]!.duration).toBe(2)
    expect(out[0]!.easing).toBe('sine.inOut')
  })

  it('rejects negative delay / non-positive duration', () => {
    const steps = [makeStep('s1', { delay: 0, duration: 0.5 })]
    const out = resolveInstanceAnimations(steps, {
      animations: { s1: { delay: -1, duration: 0 } },
    })
    expect(out[0]!.delay).toBe(0)
    expect(out[0]!.duration).toBe(0.5)
  })

  it('preserves dangling step overrides without mutating input', () => {
    const steps = [makeStep('s1')]
    const overrides: ComponentInstanceOverrides = {
      animations: {
        s1: { trigger: 'onClick' },
        ghost: { disabled: true },
      },
    }
    const out = resolveInstanceAnimations(steps, overrides)
    expect(out).toHaveLength(1)
    expect(out[0]!.trigger).toBe('onClick')
    expect(overrides.animations!['ghost']).toEqual({ disabled: true })
  })

  it('passes through untouched steps by identity', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const out = resolveInstanceAnimations(steps, {
      animations: { s2: { delay: 1 } },
    })
    expect(out[0]).toBe(steps[0])
    expect(out[1]).not.toBe(steps[1])
  })

  it('no-op on empty overrides patch returns step identity', () => {
    const steps = [makeStep('s1')]
    const out = resolveInstanceAnimations(steps, { animations: { s1: {} } })
    expect(out[0]).toBe(steps[0])
  })

  // P8 — order override (per-instance step reorder)

  it('preserves master order when no `order` overrides are set', () => {
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const out = resolveInstanceAnimations(steps, {
      animations: { s2: { delay: 1 } },
    })
    expect(out.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
  })

  it('moves a single step to a new position when only one `order` is set', () => {
    // Master order: s1, s2, s3. Pin s3 to order 0 → it floats to the top;
    // unordered s1, s2 follow in master order.
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const out = resolveInstanceAnimations(steps, {
      animations: { s3: { order: 0 } },
    })
    expect(out.map((s) => s.id)).toEqual(['s3', 's1', 's2'])
  })

  it('sorts multiple `order` overrides ascending; unordered steps stay in master order behind', () => {
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3'), makeStep('s4')]
    const out = resolveInstanceAnimations(steps, {
      animations: {
        s4: { order: 0 },
        s2: { order: 1 },
      },
    })
    // s4 (order 0), s2 (order 1), then s1 + s3 in master order.
    expect(out.map((s) => s.id)).toEqual(['s4', 's2', 's1', 's3'])
  })

  it('breaks ties on equal `order` by master index (stable)', () => {
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const out = resolveInstanceAnimations(steps, {
      animations: {
        s2: { order: 0 },
        s3: { order: 0 },
      },
    })
    // s2 and s3 share order=0; s2 comes first because its master index is lower.
    expect(out.map((s) => s.id)).toEqual(['s2', 's3', 's1'])
  })

  it('ignores non-finite `order` values', () => {
    const steps = [makeStep('s1'), makeStep('s2')]
    const out = resolveInstanceAnimations(steps, {
      animations: {
        // NaN / Infinity are ignored — the override is treated as if order was missing.
        s2: { order: Number.NaN },
      },
    })
    expect(out.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('drops disabled steps even when they have an `order` override', () => {
    const steps = [makeStep('s1'), makeStep('s2'), makeStep('s3')]
    const out = resolveInstanceAnimations(steps, {
      animations: {
        s2: { disabled: true, order: 0 },
        s3: { order: 1 },
      },
    })
    // s2 dropped; s3 floats to ordered slot; s1 trails behind unordered.
    expect(out.map((s) => s.id)).toEqual(['s3', 's1'])
  })

  it('field overrides still apply after re-sort by `order`', () => {
    const steps = [makeStep('s1', { delay: 0 }), makeStep('s2', { delay: 0 })]
    const out = resolveInstanceAnimations(steps, {
      animations: {
        s2: { order: 0, delay: 1.5 },
      },
    })
    expect(out.map((s) => s.id)).toEqual(['s2', 's1'])
    expect(out[0]!.delay).toBe(1.5)
  })
})
