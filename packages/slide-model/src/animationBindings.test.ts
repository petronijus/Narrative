/**
 * animationBindings.test.ts
 *
 * Round-trip testy: AnimationStep → Y.Map (uvnitř Y.Doc) → AnimationStep musí být identity.
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  animationStepToYMap,
  animationStepToYMapInDoc,
  yMapToAnimationStep,
} from './animationBindings.js'
import type { AnimationStep } from '@narrative/shared'

const sampleStep: AnimationStep = {
  id: 'step-1',
  objectId: 'obj-1',
  preset: 'fadeIn',
  trigger: 'onEnter',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

const sampleStepWithParams: AnimationStep = {
  id: 'step-2',
  objectId: 'obj-2',
  preset: 'slideIn',
  trigger: 'afterPrevious',
  duration: 1.0,
  delay: 0.2,
  easing: 'sine.inOut',
  params: { direction: 'up', distance: 100 },
}

describe('animationStepToYMapInDoc → yMapToAnimationStep round-trip', () => {
  it('fadeIn bez params — round-trip', () => {
    const doc = new Y.Doc()
    const yMap = animationStepToYMapInDoc(doc, sampleStep)
    const result = yMapToAnimationStep(yMap)
    expect(result).toEqual(sampleStep)
  })

  it('slideIn s params — round-trip', () => {
    const doc = new Y.Doc()
    const yMap = animationStepToYMapInDoc(doc, sampleStepWithParams)
    const result = yMapToAnimationStep(yMap)
    expect(result).toEqual(sampleStepWithParams)
  })

  it('Y.Map obsahuje všechny povinné fields', () => {
    const doc = new Y.Doc()
    const yMap = animationStepToYMapInDoc(doc, sampleStep)
    expect(yMap.get('id')).toBe('step-1')
    expect(yMap.get('objectId')).toBe('obj-1')
    expect(yMap.get('preset')).toBe('fadeIn')
    expect(yMap.get('trigger')).toBe('onEnter')
    expect(yMap.get('duration')).toBe(0.5)
    expect(yMap.get('delay')).toBe(0)
    expect(yMap.get('easing')).toBe('power2.out')
  })

  it('params field je zachován jako plain object', () => {
    const doc = new Y.Doc()
    const yMap = animationStepToYMapInDoc(doc, sampleStepWithParams)
    expect(yMap.get('params')).toEqual({ direction: 'up', distance: 100 })
  })
})

describe('animationStepToYMap (standalone — pro insert do Y.Array)', () => {
  it('vrátí Y.Map, hodnoty čitelné po integraci do doc', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('animations')
    const yMap = animationStepToYMap(sampleStep)

    doc.transact(() => {
      arr.push([yMap])
    })

    expect(yMap.get('id')).toBe('step-1')
    expect(yMap.get('preset')).toBe('fadeIn')
  })
})

describe('yMapToAnimationStep — error handling', () => {
  it('vyhodí na chybějícím id fieldu', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('animations')
    const yMap = new Y.Map<unknown>()
    doc.transact(() => {
      yMap.set('objectId', 'obj-1')
      // id záměrně chybí
      arr.push([yMap])
    })
    expect(() => yMapToAnimationStep(yMap)).toThrow('missing required "id" field')
  })

  it('vyhodí na chybějícím objectId fieldu', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<Y.Map<unknown>>('animations')
    const yMap = new Y.Map<unknown>()
    doc.transact(() => {
      yMap.set('id', 'step-x')
      // objectId záměrně chybí
      arr.push([yMap])
    })
    expect(() => yMapToAnimationStep(yMap)).toThrow('missing required "objectId" field')
  })
})
