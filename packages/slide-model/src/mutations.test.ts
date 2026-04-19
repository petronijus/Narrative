/**
 * mutations.test.ts
 *
 * Testy pro mutation API — addObject, removeObject, updateObject, undo/redo.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import {
  addObject,
  removeObject,
  updateObject,
  createObjectOfType,
  LOCAL_ORIGIN,
  type MutationContext,
} from './mutations.js'
import { registerObjectType, _clearRegistry } from './registry.js'
import { createUndoManager } from './undo.js'
import { yMapToPlainObject } from './bindings.js'
import type { RectangleObject } from '@narrative/shared'

function makeCtx(): MutationContext {
  const { doc, objects } = createSlideDoc()
  return { doc, objects }
}

function makePlainYMap(obj: Record<string, unknown>): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(obj)) {
    yMap.set(k, v)
  }
  return yMap
}

const sampleRect: RectangleObject = {
  id: 'r1',
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 50,
  fill: 0xff0000,
  rotation: 0,
  opacity: 1,
}

beforeEach(() => {
  _clearRegistry()
})

describe('addObject', () => {
  it('přidá objekt do Y.Array', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    expect(ctx.objects.length).toBe(1)
    const result = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    expect(result).toEqual(sampleRect)
  })

  it('přidá více objektů', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)
    addObject(ctx, { ...sampleRect, id: 'r2' })

    expect(ctx.objects.length).toBe(2)
  })
})

describe('removeObject', () => {
  it('odstraní objekt podle id', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)
    addObject(ctx, { ...sampleRect, id: 'r2' })

    removeObject(ctx, 'r1')

    expect(ctx.objects.length).toBe(1)
    const remaining = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    expect(remaining.id).toBe('r2')
  })

  it('no-op pokud id neexistuje', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    expect(() => removeObject(ctx, 'nonexistent')).not.toThrow()
    expect(ctx.objects.length).toBe(1)
  })
})

describe('updateObject', () => {
  it('aktualizuje properties objektu', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    updateObject<RectangleObject>(ctx, 'r1', { x: 999, fill: 0x0000ff })

    const updated = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    expect(updated.x).toBe(999)
    expect(updated.fill).toBe(0x0000ff)
    // ostatní zůstávají
    expect(updated.y).toBe(20)
    expect(updated.id).toBe('r1')
    expect(updated.type).toBe('rectangle')
  })

  it('no-op pokud id neexistuje', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    expect(() => updateObject<RectangleObject>(ctx, 'nope', { x: 1 })).not.toThrow()
    expect(ctx.objects.length).toBe(1)
  })
})

describe('createObjectOfType', () => {
  beforeEach(() => {
    registerObjectType<RectangleObject>({
      type: 'rectangle',
      defaultProps: () => ({
        x: 50,
        y: 50,
        width: 200,
        height: 150,
        fill: 0x4060e0,
        rotation: 0,
        opacity: 1,
      }),
    })
  })

  it('vytvoří objekt s vygenerovaným id', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'rectangle')

    expect(typeof obj.id).toBe('string')
    expect(obj.id.length).toBeGreaterThan(0)
    expect(obj.type).toBe('rectangle')
    expect(ctx.objects.length).toBe(1)
  })

  it('aplikuje overrides na defaultProps', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'rectangle', { x: 999, y: 888 })

    expect(obj.x).toBe(999)
    expect(obj.y).toBe(888)
    // default fill stále platí
    const rect = obj as RectangleObject
    expect(rect.fill).toBe(0x4060e0)
  })

  it('vyhodí chybu pro neregistrovaný typ', () => {
    const ctx = makeCtx()

    expect(() => createObjectOfType(ctx, 'ellipse')).toThrow("type 'ellipse' is not registered")
  })
})

describe('LOCAL_ORIGIN a UndoManager', () => {
  beforeEach(() => {
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

  it('undo odstraní přidaný objekt', () => {
    const ctx = makeCtx()
    const um = createUndoManager(ctx)

    addObject(ctx, sampleRect)
    expect(ctx.objects.length).toBe(1)

    um.undo()
    expect(ctx.objects.length).toBe(0)
  })

  it('redo vrátí objekt po undo', () => {
    const ctx = makeCtx()
    const um = createUndoManager(ctx)

    addObject(ctx, sampleRect)
    um.undo()
    expect(ctx.objects.length).toBe(0)

    um.redo()
    expect(ctx.objects.length).toBe(1)
  })

  it('LOCAL_ORIGIN je Symbol', () => {
    expect(typeof LOCAL_ORIGIN).toBe('symbol')
  })

  it('transakce bez LOCAL_ORIGIN se neundí (simulace remote change)', () => {
    const ctx = makeCtx()
    const um = createUndoManager(ctx)

    // Remote change — jiný origin (ne LOCAL_ORIGIN)
    const remoteOrigin = Symbol('remote')
    ctx.doc.transact(() => {
      ctx.objects.push([makePlainYMap({ ...sampleRect, id: 'remote-1' })])
    }, remoteOrigin)

    expect(ctx.objects.length).toBe(1)
    um.undo() // nemělo by nic udělat — remote change není trackovaný
    expect(ctx.objects.length).toBe(1)
  })
})
