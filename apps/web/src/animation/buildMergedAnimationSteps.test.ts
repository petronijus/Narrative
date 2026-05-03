/**
 * animation/buildMergedAnimationSteps.test.ts
 *
 * M16 P8 — Pure tests for the slide-level animation merger. No Yjs,
 * no Pixi, no React — the merger is a pure function of (slide steps,
 * slide objects, master-snapshot accessor).
 */

import { describe, it, expect } from 'vitest'
import type {
  AnimationStep,
  ComponentInstanceObject,
  RectangleObject,
  SlideObject,
} from '@narrative/shared'
import {
  buildMergedAnimationSteps,
  indexGroupsByInstance,
  parseMergedStepId,
} from './buildMergedAnimationSteps.js'

function makeStep(
  id: string,
  objectId: string,
  overrides: Partial<AnimationStep> = {},
): AnimationStep {
  return {
    id,
    objectId,
    preset: 'fadeIn',
    trigger: 'onEnter',
    duration: 0.5,
    delay: 0,
    easing: 'power2.out',
    ...overrides,
  }
}

function makeRect(id: string): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fill: 0,
    rotation: 0,
    opacity: 1,
  }
}

function makeInstance(
  id: string,
  componentId: string,
  overrides?: Partial<ComponentInstanceObject>,
): ComponentInstanceObject {
  return {
    id,
    type: 'componentInstance',
    componentId,
    componentName: 'Big Title',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    ...overrides,
  }
}

describe('buildMergedAnimationSteps', () => {
  it('returns slide-native steps unchanged when no instances exist', () => {
    const native = [makeStep('s1', 'rect-a'), makeStep('s2', 'rect-b')]
    const objects: SlideObject[] = [makeRect('rect-a'), makeRect('rect-b')]
    const out = buildMergedAnimationSteps(native, objects, () => null)

    expect(out.steps).toHaveLength(2)
    expect(out.steps[0]).toBe(native[0])
    expect(out.steps[1]).toBe(native[1])
    expect(out.groups).toHaveLength(0)
  })

  it('appends per-instance master steps in slide z-order with remapped target ids', () => {
    const native = [makeStep('n1', 'rect-a')]
    const objects: SlideObject[] = [
      makeRect('rect-a'),
      makeInstance('inst-1', 'comp-1'),
      makeInstance('inst-2', 'comp-1'),
    ]
    const masterSteps = [makeStep('m1', 'leaf-1'), makeStep('m2', 'leaf-2')]
    const out = buildMergedAnimationSteps(native, objects, () => masterSteps)

    expect(out.steps).toHaveLength(1 + 2 + 2)
    // Native first, identity preserved.
    expect(out.steps[0]).toBe(native[0])
    // Then inst-1 in master order.
    expect(out.steps[1]!.id).toBe('inst-1:m1')
    expect(out.steps[1]!.objectId).toBe('instance:inst-1:leaf-1')
    expect(out.steps[2]!.id).toBe('inst-1:m2')
    // Then inst-2.
    expect(out.steps[3]!.id).toBe('inst-2:m1')
    expect(out.steps[3]!.objectId).toBe('instance:inst-2:leaf-1')
    expect(out.steps[4]!.id).toBe('inst-2:m2')
  })

  it('emits an AnimationGroup per instance with master step ids parallel to steps', () => {
    const objects: SlideObject[] = [makeInstance('inst-1', 'comp-1', { componentName: 'Hero' })]
    const masterSteps = [makeStep('m1', 'leaf-1'), makeStep('m2', 'leaf-2')]
    const out = buildMergedAnimationSteps([], objects, () => masterSteps)

    expect(out.groups).toHaveLength(1)
    const g = out.groups[0]!
    expect(g.kind).toBe('componentInstance')
    expect(g.instanceId).toBe('inst-1')
    expect(g.componentId).toBe('comp-1')
    expect(g.label).toBe('Hero')
    expect(g.steps).toHaveLength(2)
    expect(g.masterStepIds).toEqual(['m1', 'm2'])
    // Group steps share identity with the flat list.
    expect(g.steps[0]).toBe(out.steps[0])
    expect(g.steps[1]).toBe(out.steps[1])
  })

  it('falls back to "Component" label when componentName is missing', () => {
    // exactOptionalPropertyTypes — drop the field rather than setting undefined.
    const inst = makeInstance('inst-1', 'comp-1')
    delete (inst as { componentName?: string }).componentName
    const objects: SlideObject[] = [inst]
    const out = buildMergedAnimationSteps([], objects, () => [makeStep('m1', 'leaf-1')])
    expect(out.groups[0]!.label).toBe('Component')
  })

  it('drops instances whose master is not yet synced (null)', () => {
    const objects: SlideObject[] = [
      makeInstance('inst-1', 'comp-pending'),
      makeInstance('inst-2', 'comp-ready'),
    ]
    const out = buildMergedAnimationSteps([], objects, (id) =>
      id === 'comp-ready' ? [makeStep('m1', 'leaf-1')] : null,
    )
    expect(out.groups).toHaveLength(1)
    expect(out.groups[0]!.instanceId).toBe('inst-2')
  })

  it('honours per-instance disabled overrides — disabled steps drop out', () => {
    const objects: SlideObject[] = [
      makeInstance('inst-1', 'comp-1', {
        overrides: { animations: { m2: { disabled: true } } },
      }),
    ]
    const masterSteps = [makeStep('m1', 'leaf-1'), makeStep('m2', 'leaf-2')]
    const out = buildMergedAnimationSteps([], objects, () => masterSteps)
    expect(out.steps).toHaveLength(1)
    expect(out.steps[0]!.id).toBe('inst-1:m1')
  })

  it('honours per-instance order override (P8)', () => {
    const objects: SlideObject[] = [
      makeInstance('inst-1', 'comp-1', {
        overrides: { animations: { m2: { order: 0 } } },
      }),
    ]
    const masterSteps = [makeStep('m1', 'leaf-1'), makeStep('m2', 'leaf-2')]
    const out = buildMergedAnimationSteps([], objects, () => masterSteps)
    expect(out.steps.map((s) => s.id)).toEqual(['inst-1:m2', 'inst-1:m1'])
    // Group's masterStepIds reflect the resolved order — important so the
    // UI's "row N" maps back to the correct master step.
    expect(out.groups[0]!.masterStepIds).toEqual(['m2', 'm1'])
  })

  it('preserves slide z-order across two instance groups', () => {
    const objects: SlideObject[] = [
      makeInstance('inst-z', 'comp-z'),
      makeRect('mid'),
      makeInstance('inst-a', 'comp-a'),
    ]
    const out = buildMergedAnimationSteps([], objects, () => [makeStep('m', 'leaf')])
    expect(out.groups.map((g) => g.instanceId)).toEqual(['inst-z', 'inst-a'])
  })

  it('does not mutate the master snapshot', () => {
    const masterSteps = [makeStep('m1', 'leaf-1')]
    const objects: SlideObject[] = [makeInstance('inst-1', 'comp-1')]
    const before = JSON.stringify(masterSteps)
    buildMergedAnimationSteps([], objects, () => masterSteps)
    expect(JSON.stringify(masterSteps)).toBe(before)
  })

  it('compiler integration: slide-native + one instance step yields a parallel timeline shape', () => {
    // Sanity check that the merge produces exactly the cardinality the
    // compiler will see: 1 native step + 1 instance step = 2 steps. The
    // compiler treats these as parallel (both onEnter at position 0).
    const native = [makeStep('s1', 'rect', { trigger: 'onEnter' })]
    const objects: SlideObject[] = [makeRect('rect'), makeInstance('inst-1', 'comp-1')]
    const masterSteps = [makeStep('m1', 'leaf-1', { trigger: 'onEnter' })]
    const out = buildMergedAnimationSteps(native, objects, () => masterSteps)
    expect(out.steps).toHaveLength(2)
    expect(out.steps.map((s) => s.trigger)).toEqual(['onEnter', 'onEnter'])
    // Different target ids → compiler will tween two different proxies in parallel.
    expect(out.steps[0]!.objectId).toBe('rect')
    expect(out.steps[1]!.objectId).toBe('instance:inst-1:leaf-1')
  })
})

describe('parseMergedStepId', () => {
  it('returns null for native (non-namespaced) step ids', () => {
    expect(parseMergedStepId('plain-step-id')).toBeNull()
  })

  it('parses instance-namespaced step ids', () => {
    expect(parseMergedStepId('inst-1:m1')).toEqual({
      instanceId: 'inst-1',
      masterStepId: 'm1',
    })
  })

  it('returns null on malformed ids (empty halves)', () => {
    expect(parseMergedStepId(':m1')).toBeNull()
    expect(parseMergedStepId('inst-1:')).toBeNull()
  })
})

describe('indexGroupsByInstance', () => {
  it('builds an instance-id → group map', () => {
    const objects: SlideObject[] = [
      makeInstance('inst-a', 'comp-1'),
      makeInstance('inst-b', 'comp-2'),
    ]
    const out = buildMergedAnimationSteps([], objects, () => [makeStep('m', 'leaf')])
    const idx = indexGroupsByInstance(out.groups)
    expect(idx.size).toBe(2)
    expect(idx.get('inst-a')!.componentId).toBe('comp-1')
    expect(idx.get('inst-b')!.componentId).toBe('comp-2')
  })
})
