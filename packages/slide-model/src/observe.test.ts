/**
 * observe.test.ts
 *
 * Testy pro subscribeToObjects observer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import { addObject, removeObject, updateObject, type ObjectsMutationContext } from './mutations.js'
import { getSlideObjectsCtx } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import { subscribeToObjects } from './observe.js'
import { registerObjectType, _clearRegistry } from './registry.js'
import type { RectangleObject } from '@narrative/shared'

function makeCtx(): ObjectsMutationContext {
  const { doc, slides } = createSlideDoc()
  const dk: SlideMutationContext = { doc, slides }
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideObjectsCtx(dk, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 objects ctx')
  return ctx
}

const sampleRect: RectangleObject = {
  id: 'rect-obs-1',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: 0,
  rotation: 0,
  opacity: 1,
}

beforeEach(() => {
  _clearRegistry()
  registerObjectType<RectangleObject>({
    type: 'rectangle',
    defaultProps: () => ({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fill: 0,
      rotation: 0,
      opacity: 1,
    }),
  })
})

describe('subscribeToObjects', () => {
  it('zavolá callback ihned s počátečním snapshotem (prázdné pole)', () => {
    const ctx = makeCtx()
    const cb = vi.fn()

    const unsub = subscribeToObjects(ctx, cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb).toHaveBeenCalledWith([])

    unsub()
  })

  it('zavolá callback ihned se stávajícími objekty', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const cb = vi.fn()
    const unsub = subscribeToObjects(ctx, cb)

    expect(cb).toHaveBeenCalledOnce()
    expect(cb.mock.calls[0]?.[0]).toHaveLength(1)

    unsub()
  })

  it('zavolá callback po addObject', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToObjects(ctx, cb)

    cb.mockClear()
    addObject(ctx, sampleRect)

    expect(cb).toHaveBeenCalled()
    const objs = cb.mock.calls[cb.mock.calls.length - 1]?.[0] as RectangleObject[]
    expect(objs).toHaveLength(1)
    expect(objs[0]?.id).toBe('rect-obs-1')

    unsub()
  })

  it('zavolá callback po removeObject', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const cb = vi.fn()
    const unsub = subscribeToObjects(ctx, cb)
    cb.mockClear()

    removeObject(ctx, 'rect-obs-1')

    expect(cb).toHaveBeenCalled()
    const objs = cb.mock.calls[cb.mock.calls.length - 1]?.[0] as RectangleObject[]
    expect(objs).toHaveLength(0)

    unsub()
  })

  it('zavolá callback po updateObject', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const cb = vi.fn()
    const unsub = subscribeToObjects(ctx, cb)
    cb.mockClear()

    updateObject<RectangleObject>(ctx, 'rect-obs-1', { x: 777 })

    expect(cb).toHaveBeenCalled()
    const objs = cb.mock.calls[cb.mock.calls.length - 1]?.[0] as RectangleObject[]
    expect(objs[0]?.x).toBe(777)

    unsub()
  })

  it('unsubscribe zastaví callback', () => {
    const ctx = makeCtx()
    const cb = vi.fn()
    const unsub = subscribeToObjects(ctx, cb)

    cb.mockClear()
    unsub()

    addObject(ctx, sampleRect)
    expect(cb).not.toHaveBeenCalled()
  })
})
