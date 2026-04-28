/**
 * mutations.test.ts
 *
 * Testy pro mutation API — addObject, removeObject, updateObject, undo/redo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Y from 'yjs'
import { createSlideDoc } from './yDoc.js'
import {
  addObject,
  addObjects,
  removeObject,
  updateObject,
  createObjectOfType,
  duplicateObject,
  bulkUpdateObjects,
  moveObjectsLayer,
  alignObjects,
  distributeObjects,
  groupObjects,
  ungroupObjects,
  getGroupMembers,
  LOCAL_ORIGIN,
  type ObjectsMutationContext,
  type BulkUpdate,
} from './mutations.js'
import { registerObjectType, _clearRegistry } from './registry.js'
import { createUndoManager } from './undo.js'
import { yMapToPlainObject } from './bindings.js'
import { getSlideObjectsCtx } from './slides.js'
import type { SlideMutationContext } from './slideMutationContext.js'
import type { RectangleObject, ImageObject, VideoObject } from '@narrative/shared'

/**
 * Creates an ObjectsMutationContext scoped to slide-0 in a fresh doc.
 * M9: objects live inside slides, not at root level.
 */
function makeCtx(): ObjectsMutationContext {
  const { doc, slides } = createSlideDoc()
  const deckCtx: SlideMutationContext = { doc, slides }
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideObjectsCtx(deckCtx, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 objects ctx')
  return ctx
}

function makeFullCtx(): SlideMutationContext {
  const { doc, slides } = createSlideDoc()
  return { doc, slides }
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

describe('createObjectOfType — image', () => {
  beforeEach(() => {
    registerObjectType<ImageObject>({
      type: 'image',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        rotation: 0,
        opacity: 1,
        assetId: '',
        variant: 'display',
        fit: 'cover',
      }),
    })
  })

  it('creates image object with default props', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'image')

    expect(obj.type).toBe('image')
    expect(typeof obj.id).toBe('string')
    expect(obj.id.length).toBeGreaterThan(0)
    expect(ctx.objects.length).toBe(1)

    const img = obj as ImageObject
    expect(img.assetId).toBe('')
    expect(img.variant).toBe('display')
    expect(img.fit).toBe('cover')
    expect(img.width).toBe(400)
    expect(img.height).toBe(300)
  })

  it('applies assetId override — typical post-upload call', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'image', {
      assetId: 'asset-real-id',
      width: 1920,
      height: 1080,
      x: 50,
      y: 50,
    }) as ImageObject

    expect(obj.assetId).toBe('asset-real-id')
    expect(obj.width).toBe(1920)
    expect(obj.height).toBe(1080)
    expect(obj.x).toBe(50)
    // defaults still applied where not overridden
    expect(obj.variant).toBe('display')
    expect(obj.fit).toBe('cover')
  })

  it('optional fields (variant, fit, alt) survive round-trip via Y.Doc', () => {
    const ctx = makeCtx()
    createObjectOfType(ctx, 'image', {
      assetId: 'asset-abc',
      variant: 'thumb',
      fit: 'contain',
    })

    const yMap = ctx.objects.get(0)
    const result = yMapToPlainObject<ImageObject>(yMap)

    expect(result.assetId).toBe('asset-abc')
    expect(result.variant).toBe('thumb')
    expect(result.fit).toBe('contain')
  })
})

describe('createObjectOfType — video', () => {
  beforeEach(() => {
    registerObjectType<VideoObject>({
      type: 'video',
      defaultProps: () => ({
        x: 100,
        y: 100,
        width: 640,
        height: 360,
        rotation: 0,
        opacity: 1,
        assetId: '',
        fit: 'contain',
        autoplay: false,
        loop: false,
        muted: true,
      }),
    })
  })

  it('creates video object with default props', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'video')

    expect(obj.type).toBe('video')
    expect(typeof obj.id).toBe('string')
    expect(obj.id.length).toBeGreaterThan(0)
    expect(ctx.objects.length).toBe(1)

    const vid = obj as VideoObject
    expect(vid.assetId).toBe('')
    expect(vid.fit).toBe('contain')
    expect(vid.autoplay).toBe(false)
    expect(vid.loop).toBe(false)
    expect(vid.muted).toBe(true)
    expect(vid.width).toBe(640)
    expect(vid.height).toBe(360)
  })

  it('applies assetId override — typical post-upload call', () => {
    const ctx = makeCtx()
    const obj = createObjectOfType(ctx, 'video', {
      assetId: 'v1',
      width: 1920,
      height: 1080,
    }) as VideoObject

    expect(obj.assetId).toBe('v1')
    expect(obj.width).toBe(1920)
    expect(obj.height).toBe(1080)
    // defaults still applied
    expect(obj.fit).toBe('contain')
    expect(obj.muted).toBe(true)
  })

  it('video fields survive Y.Doc round-trip', () => {
    const ctx = makeCtx()
    createObjectOfType(ctx, 'video', {
      assetId: 'v2',
      autoplay: true,
      loop: true,
      muted: false,
      alt: 'Product demo',
    })

    const yMap = ctx.objects.get(0)
    const result = yMapToPlainObject<VideoObject>(yMap)

    expect(result.assetId).toBe('v2')
    expect(result.autoplay).toBe(true)
    expect(result.loop).toBe(true)
    expect(result.muted).toBe(false)
    expect(result.alt).toBe('Product demo')
    expect(result.type).toBe('video')
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
    const deckCtx = makeFullCtx()
    const um = createUndoManager(deckCtx)
    const ctx = makeCtx() // separate slide-scoped ctx sharing same doc would need different setup
    // Use a fresh ctx scoped to slide-0 for object operations
    const objectsCtx = (() => {
      const { doc, slides } = createSlideDoc()
      const dk: SlideMutationContext = { doc, slides }
      const firstSlideId = slides.get(0).get('id') as string
      const c = getSlideObjectsCtx(dk, firstSlideId)
      if (c === null) throw new Error('no objects ctx')
      // Create undo manager on the same deck
      const undoMgr = createUndoManager(dk)
      return { c, undoMgr }
    })()

    addObject(objectsCtx.c, sampleRect)
    expect(objectsCtx.c.objects.length).toBe(1)

    objectsCtx.undoMgr.undo()
    expect(objectsCtx.c.objects.length).toBe(0)

    void ctx // suppress unused
    void um // suppress unused
  })

  it('redo vrátí objekt po undo', () => {
    const { doc, slides } = createSlideDoc()
    const dk: SlideMutationContext = { doc, slides }
    const firstSlideId = slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(dk, firstSlideId)
    if (objectsCtx === null) throw new Error('no objects ctx')
    const um = createUndoManager(dk)

    addObject(objectsCtx, sampleRect)
    um.undo()
    expect(objectsCtx.objects.length).toBe(0)

    um.redo()
    expect(objectsCtx.objects.length).toBe(1)
  })

  it('LOCAL_ORIGIN je Symbol', () => {
    expect(typeof LOCAL_ORIGIN).toBe('symbol')
  })

  it('transakce bez LOCAL_ORIGIN se neundí (simulace remote change)', () => {
    const { doc, slides } = createSlideDoc()
    const dk: SlideMutationContext = { doc, slides }
    const firstSlideId = slides.get(0).get('id') as string
    const objectsCtx = getSlideObjectsCtx(dk, firstSlideId)
    if (objectsCtx === null) throw new Error('no objects ctx')
    const um = createUndoManager(dk)

    // Remote change — jiný origin (ne LOCAL_ORIGIN)
    const remoteOrigin = Symbol('remote')
    objectsCtx.doc.transact(() => {
      objectsCtx.objects.push([makePlainYMap({ ...sampleRect, id: 'remote-1' })])
    }, remoteOrigin)

    expect(objectsCtx.objects.length).toBe(1)
    um.undo() // nemělo by nic udělat — remote change není trackovaný
    expect(objectsCtx.objects.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// duplicateObject
// ---------------------------------------------------------------------------

describe('duplicateObject', () => {
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

  it('vrátí kopii s novým id a defaultním posunem 20/20', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const dup = duplicateObject(ctx, 'r1')

    expect(dup).not.toBeNull()
    expect(dup!.id).not.toBe('r1')
    expect(dup!.x).toBe(sampleRect.x + 20)
    expect(dup!.y).toBe(sampleRect.y + 20)
  })

  it('source neexistuje → vrátí null a vypíše warn', () => {
    const ctx = makeCtx()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = duplicateObject(ctx, 'neexistuje')
    warnSpy.mockRestore()

    expect(result).toBeNull()
    expect(ctx.objects.length).toBe(0)
  })

  it('respektuje custom offset', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const dup = duplicateObject(ctx, 'r1', { x: 5, y: 10 })

    expect(dup!.x).toBe(sampleRect.x + 5)
    expect(dup!.y).toBe(sampleRect.y + 10)
  })

  it('zachová type + type-specific fields (fill pro rectangle)', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    const dup = duplicateObject(ctx, 'r1') as RectangleObject

    expect(dup.type).toBe('rectangle')
    expect(dup.fill).toBe(sampleRect.fill)
    expect(dup.width).toBe(sampleRect.width)
    expect(dup.height).toBe(sampleRect.height)
    expect(dup.rotation).toBe(sampleRect.rotation)
    expect(dup.opacity).toBe(sampleRect.opacity)
  })

  it('zachová type + type-specific fields pro TextObject', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerObjectType<any>({
      type: 'text',
      defaultProps: () => ({
        x: 0,
        y: 0,
        width: 240,
        height: 40,
        text: 'Hello',
        fontSize: 24,
        fontWeight: 'normal',
        color: 0x000000,
        align: 'left',
        rotation: 0,
        opacity: 1,
      }),
    })

    const ctx = makeCtx()
    const textObj = {
      id: 't1',
      type: 'text' as const,
      x: 50,
      y: 50,
      width: 240,
      height: 40,
      text: 'Hello',
      fontSize: 24,
      fontWeight: 'normal' as const,
      color: 0x000000,
      align: 'left' as const,
      rotation: 0,
      opacity: 1,
    }
    addObject(ctx, textObj)

    const dup = duplicateObject(ctx, 't1') as typeof textObj

    expect(dup.type).toBe('text')
    // text is a Y.Text after the rich-text migration; assert its
    // string contents and that it's a fresh instance.
    expect(dup.text).toBeInstanceOf(Y.Text)
    expect((dup.text as unknown as Y.Text).toString()).toBe('Hello')
    expect(dup.fontSize).toBe(24)
    expect(dup.color).toBe(0x000000)
    expect(dup.id).not.toBe('t1')
  })

  it('duplikát je na konci Y.Array (nejvyšší z-order)', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)
    addObject(ctx, { ...sampleRect, id: 'r2' })

    const dup = duplicateObject(ctx, 'r1')!

    expect(ctx.objects.length).toBe(3)
    const last = ctx.objects.get(ctx.objects.length - 1)
    expect(last.get('id')).toBe(dup.id)
  })

  it('single transaction — observer fires 1× pro add', () => {
    const ctx = makeCtx()
    addObject(ctx, sampleRect)

    let fireCount = 0
    ctx.objects.observe(() => {
      fireCount++
    })

    duplicateObject(ctx, 'r1')

    expect(fireCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// bulkUpdateObjects
// ---------------------------------------------------------------------------

describe('bulkUpdateObjects', () => {
  const r1: RectangleObject = { ...sampleRect, id: 'r1' }
  const r2: RectangleObject = { ...sampleRect, id: 'r2', x: 200, y: 200 }
  const r3: RectangleObject = { ...sampleRect, id: 'r3', x: 300, y: 300 }

  it('3 updates — všechny aplikovány, observer fires 1×', () => {
    const ctx = makeCtx()
    addObject(ctx, r1)
    addObject(ctx, r2)
    addObject(ctx, r3)

    // observeDeep zachytí i nested Y.Map property changes (na rozdíl od observe)
    let fireCount = 0
    ctx.objects.observeDeep(() => {
      fireCount++
    })

    const updates: BulkUpdate[] = [
      { id: 'r1', patch: { x: 11 } },
      { id: 'r2', patch: { x: 22 } },
      { id: 'r3', patch: { x: 33 } },
    ]
    bulkUpdateObjects(ctx, updates)

    expect(fireCount).toBe(1)

    const plain1 = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    const plain2 = yMapToPlainObject<RectangleObject>(ctx.objects.get(1))
    const plain3 = yMapToPlainObject<RectangleObject>(ctx.objects.get(2))
    expect(plain1.x).toBe(11)
    expect(plain2.x).toBe(22)
    expect(plain3.x).toBe(33)
  })

  it('1 neexistující id + 2 validní → 2 aplikovány, 1 warn, observer fires 1×', () => {
    const ctx = makeCtx()
    addObject(ctx, r1)
    addObject(ctx, r2)

    let fireCount = 0
    ctx.objects.observeDeep(() => {
      fireCount++
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const updates: BulkUpdate[] = [
      { id: 'neexistuje', patch: { x: 999 } },
      { id: 'r1', patch: { x: 111 } },
      { id: 'r2', patch: { x: 222 } },
    ]
    bulkUpdateObjects(ctx, updates)
    const warnCalls = warnSpy.mock.calls.length
    warnSpy.mockRestore()

    expect(warnCalls).toBe(1)
    expect(fireCount).toBe(1)

    const plain1 = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    const plain2 = yMapToPlainObject<RectangleObject>(ctx.objects.get(1))
    expect(plain1.x).toBe(111)
    expect(plain2.x).toBe(222)
  })

  it('prázdné updates → no-op, žádný observer fire', () => {
    const ctx = makeCtx()
    addObject(ctx, r1)

    let fireCount = 0
    ctx.objects.observe(() => {
      fireCount++
    })

    bulkUpdateObjects(ctx, [])

    expect(fireCount).toBe(0)
  })

  it('undo vrátí celou batch v jednom kroku', () => {
    // Setup: deck ctx + scoped objects ctx
    const { doc, slides } = createSlideDoc()
    const deckCtx: SlideMutationContext = { doc, slides }
    const firstSlideId = slides.get(0).get('id') as string
    const ctx = getSlideObjectsCtx(deckCtx, firstSlideId)
    if (ctx === null) throw new Error('no objects ctx')

    // Přidáme objekty bez UndoManageru — tyto operace nebudou v undo stacku
    addObject(ctx, r1)
    addObject(ctx, r2)

    // Zapamatujeme si původní hodnoty
    const origX1 = yMapToPlainObject<RectangleObject>(ctx.objects.get(0)).x
    const origX2 = yMapToPlainObject<RectangleObject>(ctx.objects.get(1)).x

    // UndoManager vytvoříme až po addObject — bude trackovat jen bulkUpdate
    const um = createUndoManager(deckCtx)

    const updates: BulkUpdate[] = [
      { id: 'r1', patch: { x: 500 } },
      { id: 'r2', patch: { x: 600 } },
    ]
    bulkUpdateObjects(ctx, updates)

    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(0)).x).toBe(500)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(1)).x).toBe(600)

    um.undo()

    // Objekty stále existují (addObject nebylo undo-ováno), jen x se vrátil
    expect(ctx.objects.length).toBe(2)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(0)).x).toBe(origX1)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(1)).x).toBe(origX2)
  })
})

// ---------------------------------------------------------------------------
// P6: layer order + align + distribute + group
// ---------------------------------------------------------------------------

describe('P6 object operations', () => {
  function seed3(ctx: ObjectsMutationContext) {
    const mk = (id: string, x: number, y: number, w = 100, h = 100): RectangleObject => ({
      id,
      type: 'rectangle',
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      opacity: 1,
      fill: 0x4060e0,
    })
    addObject(ctx, mk('a', 0, 0))
    addObject(ctx, mk('b', 200, 0))
    addObject(ctx, mk('c', 400, 0))
  }

  it('moveObjectsLayer front → selected ends up last in Y.Array', () => {
    const ctx = makeCtx()
    seed3(ctx)
    moveObjectsLayer(ctx, ['a'], 'front')
    const ids = [
      ctx.objects.get(0).get('id'),
      ctx.objects.get(1).get('id'),
      ctx.objects.get(2).get('id'),
    ]
    expect(ids).toEqual(['b', 'c', 'a'])
  })

  it('moveObjectsLayer back → selected ends up first in Y.Array', () => {
    const ctx = makeCtx()
    seed3(ctx)
    moveObjectsLayer(ctx, ['c'], 'back')
    const ids = [
      ctx.objects.get(0).get('id'),
      ctx.objects.get(1).get('id'),
      ctx.objects.get(2).get('id'),
    ]
    expect(ids).toEqual(['c', 'a', 'b'])
  })

  it('moveObjectsLayer forward on a single middle object shifts it past one neighbour', () => {
    const ctx = makeCtx()
    seed3(ctx) // [a, b, c]
    moveObjectsLayer(ctx, ['b'], 'forward')
    const ids = [
      ctx.objects.get(0).get('id'),
      ctx.objects.get(1).get('id'),
      ctx.objects.get(2).get('id'),
    ]
    expect(ids).toEqual(['a', 'c', 'b'])
    // All 3 objects still present — the old bug dropped the selected id.
    expect(ctx.objects.length).toBe(3)
  })

  it('moveObjectsLayer backward on a single middle object shifts it past one neighbour', () => {
    const ctx = makeCtx()
    seed3(ctx) // [a, b, c]
    moveObjectsLayer(ctx, ['b'], 'backward')
    const ids = [
      ctx.objects.get(0).get('id'),
      ctx.objects.get(1).get('id'),
      ctx.objects.get(2).get('id'),
    ]
    expect(ids).toEqual(['b', 'a', 'c'])
    expect(ctx.objects.length).toBe(3)
  })

  it('moveObjectsLayer forward at the top edge is a no-op', () => {
    const ctx = makeCtx()
    seed3(ctx) // [a, b, c]
    moveObjectsLayer(ctx, ['c'], 'forward')
    const ids = [
      ctx.objects.get(0).get('id'),
      ctx.objects.get(1).get('id'),
      ctx.objects.get(2).get('id'),
    ]
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('alignObjects left snaps every object to union left edge', () => {
    const ctx = makeCtx()
    seed3(ctx)
    alignObjects(ctx, ['a', 'b', 'c'], 'left')
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(0)).x).toBe(0)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(1)).x).toBe(0)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(2)).x).toBe(0)
  })

  it('alignObjects center-x centers every object on union midpoint', () => {
    const ctx = makeCtx()
    seed3(ctx)
    alignObjects(ctx, ['a', 'b', 'c'], 'center-x')
    // Union: 0..500. Midpoint 250. Each 100 wide → x = 250 - 50 = 200.
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(0)).x).toBe(200)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(1)).x).toBe(200)
    expect(yMapToPlainObject<RectangleObject>(ctx.objects.get(2)).x).toBe(200)
  })

  it('distributeObjects horizontal → equal gaps between objects', () => {
    const ctx = makeCtx()
    seed3(ctx)
    // a at x=0, c at x=400. Middle b should land so gap(a,b) == gap(b,c).
    distributeObjects(ctx, ['a', 'b', 'c'], 'horizontal')
    const a = yMapToPlainObject<RectangleObject>(ctx.objects.get(0))
    const b = yMapToPlainObject<RectangleObject>(ctx.objects.get(1))
    const c = yMapToPlainObject<RectangleObject>(ctx.objects.get(2))
    expect(a.x).toBe(0)
    expect(c.x).toBe(400)
    // Gap before b = b.x - (a.x + a.width) = b.x - 100. After b = c.x - (b.x + 100).
    expect(b.x - 100).toBe(c.x - b.x - 100)
  })

  it('groupObjects assigns the same groupId to all members', () => {
    const ctx = makeCtx()
    seed3(ctx)
    groupObjects(ctx, ['a', 'b'])
    const ga = ctx.objects.get(0).get('groupId')
    const gb = ctx.objects.get(1).get('groupId')
    const gc = ctx.objects.get(2).get('groupId')
    expect(typeof ga).toBe('string')
    expect(ga).toBe(gb)
    expect(gc).toBeUndefined()
  })

  it('ungroupObjects removes groupId', () => {
    const ctx = makeCtx()
    seed3(ctx)
    groupObjects(ctx, ['a', 'b'])
    ungroupObjects(ctx, ['a', 'b'])
    expect(ctx.objects.get(0).get('groupId')).toBeUndefined()
    expect(ctx.objects.get(1).get('groupId')).toBeUndefined()
  })

  it('getGroupMembers expands a single id into all group siblings', () => {
    const ctx = makeCtx()
    seed3(ctx)
    groupObjects(ctx, ['a', 'c'])
    const members = getGroupMembers(ctx, 'a').sort()
    expect(members).toEqual(['a', 'c'])
  })

  it('getGroupMembers on an ungrouped object returns just that id', () => {
    const ctx = makeCtx()
    seed3(ctx)
    expect(getGroupMembers(ctx, 'b')).toEqual(['b'])
  })

  it('addObjects pushes multiple objects in one transaction', () => {
    const ctx = makeCtx()
    const mk = (id: string, x: number): RectangleObject => ({
      id,
      type: 'rectangle',
      x,
      y: 0,
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      fill: 0x4060e0,
    })
    addObjects(ctx, [mk('x', 0), mk('y', 100), mk('z', 200)])
    expect(ctx.objects.length).toBe(3)
    expect(ctx.objects.get(0).get('id')).toBe('x')
    expect(ctx.objects.get(2).get('id')).toBe('z')
  })
})
