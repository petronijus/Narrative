/**
 * duplicateObjects group remapping + crop-carrying translation
 * (translateObjects, alignObjects, distributeObjects).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { ImageObject, RectangleObject, SlideObject } from '@narrative/shared'
import { createSlideDoc } from './yDoc.js'
import { getSlideObjectsCtx } from './slides.js'
import { yMapToPlainObject } from './bindings.js'
import { addSlide } from './slides.js'
import { applyFormat } from './richText.js'
import {
  addObject,
  addObjects,
  alignObjects,
  copyObjectsTo,
  distributeObjects,
  duplicateObject,
  duplicateObjects,
  translateObjects,
  type ObjectsMutationContext,
} from './mutations.js'
import { createUndoManager } from './undo.js'

function makeCtx(): { ctx: ObjectsMutationContext; undo: ReturnType<typeof createUndoManager> } {
  const deck = createSlideDoc()
  const ctx = getSlideObjectsCtx(deck, deck.slides.get(0).get('id') as string)
  if (ctx === null) throw new Error('no slide-0 ctx')
  return { ctx, undo: createUndoManager(deck) }
}

function rect(
  id: string,
  x: number,
  y: number,
  extra: Partial<RectangleObject> = {},
): RectangleObject {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 50,
    fill: 0,
    rotation: 0,
    opacity: 1,
    ...extra,
  }
}

function croppedImage(id: string, x: number, y: number): ImageObject {
  return {
    id,
    type: 'image',
    assetId: 'asset-1',
    x,
    y,
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    imageRect: { x: x - 50, y: y - 20, width: 400, height: 300 },
  }
}

function all(ctx: ObjectsMutationContext) {
  return ctx.objects.toArray().map((m) => yMapToPlainObject(m))
}

describe('duplicateObjects', () => {
  it('gives a duplicated group its own fresh group instead of growing the original', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [rect('a', 0, 0, { groupId: 'g1' }), rect('b', 200, 0, { groupId: 'g1' })])
    const copies = duplicateObjects(ctx, ['a', 'b'])
    expect(copies).toHaveLength(2)
    const g = copies[0]!.groupId
    expect(g).toBeDefined()
    expect(g).not.toBe('g1')
    expect(copies[1]!.groupId).toBe(g)
    // The original group still has exactly its two members.
    expect(
      all(ctx)
        .filter((o) => o.groupId === 'g1')
        .map((o) => o.id),
    ).toEqual(['a', 'b'])
  })

  it('keeps a stamp link with a fresh instance per copied stamp', () => {
    const { ctx } = makeCtx()
    const from = (objectId: string, instance: string) => ({
      component: { id: 'cmp', objectId, instance, origin: { x: 0, y: 0 } },
    })
    addObjects(ctx, [
      rect('a', 0, 0, from('m1', 'i1')),
      rect('b', 200, 0, from('m2', 'i1')),
      rect('c', 400, 0, from('m1', 'i2')),
      rect('plain', 600, 0),
    ])
    const copies = duplicateObjects(ctx, ['a', 'b', 'c', 'plain'])
    const [a, b, c, plain] = copies
    expect(a!.component).toMatchObject({ id: 'cmp', objectId: 'm1', origin: { x: 0, y: 0 } })
    expect(a!.component!.instance).not.toBe('i1')
    expect(b!.component!.instance).toBe(a!.component!.instance)
    expect(c!.component!.instance).not.toBe('i2')
    expect(c!.component!.instance).not.toBe(a!.component!.instance)
    expect(plain!.component).toBeUndefined()
    // The originals keep theirs.
    expect(all(ctx)[0]!.component!.instance).toBe('i1')
  })

  it('drops the group of a lone member copy (a group of one means nothing)', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [rect('a', 0, 0, { groupId: 'g1' }), rect('b', 200, 0, { groupId: 'g1' })])
    const copy = duplicateObject(ctx, 'a')!
    expect(copy.groupId).toBeUndefined()
  })

  it('keeps the sources relative z-order, regardless of the order of ids', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [rect('back', 0, 0), rect('front', 10, 10)])
    const copies = duplicateObjects(ctx, ['front', 'back'])
    expect(copies.map((c) => c.x)).toEqual([20, 30])
  })

  it('is one undo step and skips unknown ids', () => {
    const { ctx, undo } = makeCtx()
    addObjects(ctx, [rect('a', 0, 0), rect('b', 0, 0)])
    undo.stopCapturing()
    expect(duplicateObjects(ctx, ['a', 'nope', 'b'])).toHaveLength(2)
    expect(ctx.objects.length).toBe(4)
    undo.undo()
    expect(ctx.objects.length).toBe(2)
  })

  it('moves a cropped image crop rect together with the offset', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [croppedImage('img', 100, 100)])
    const [copy] = duplicateObjects(ctx, ['img'], { x: 20, y: 30 }) as ImageObject[]
    expect(copy!.imageRect).toEqual({ x: 70, y: 110, width: 400, height: 300 })
  })
})

describe('copyObjectsTo', () => {
  it('copies onto another slide: fresh ids, rich text, groups and the crop come along', () => {
    const deck = createSlideDoc()
    const from = getSlideObjectsCtx(deck, deck.slides.get(0).get('id') as string)!
    const second = addSlide(deck)
    const to = getSlideObjectsCtx(deck, second.id)!
    addObjects(from, [
      rect('a', 0, 0, { groupId: 'g1' }),
      rect('b', 200, 0, { groupId: 'g1' }),
      croppedImage('img', 100, 100),
    ])
    addObject(from, {
      id: 't',
      type: 'text',
      x: 0,
      y: 300,
      width: 400,
      height: 100,
      rotation: 0,
      opacity: 1,
      text: 'Hello world',
      fontSize: 24,
      color: 0,
    } as never)
    const t = from.objects.get(3).get('text') as Y.Text
    deck.doc.transact(() => applyFormat(t, 0, 5, { italic: true }))

    const copies = copyObjectsTo(from, to, ['img', 'b', 'a', 't'], { x: 10, y: 0 })
    expect(copies.map((c) => c.type)).toEqual(['rectangle', 'rectangle', 'image', 'text'])
    expect(from.objects.length).toBe(4)
    expect(to.objects.length).toBe(4)
    const [ca, cb, cimg, ct] = copies as [
      RectangleObject,
      RectangleObject,
      ImageObject,
      SlideObject,
    ]
    expect(ca.id).not.toBe('a')
    expect(ca.groupId).toBeDefined()
    expect(ca.groupId).not.toBe('g1')
    expect(cb.groupId).toBe(ca.groupId)
    expect(cimg.imageRect).toEqual({ x: 60, y: 80, width: 400, height: 300 })
    const copiedText = to.objects.get(3).get('text') as Y.Text
    expect(copiedText.toDelta()[0]).toMatchObject({ insert: 'Hello', attributes: { italic: true } })
    expect(ct.x).toBe(10)
  })

  it('refuses slides of two different documents', () => {
    const a = createSlideDoc()
    const b = createSlideDoc()
    const from = getSlideObjectsCtx(a, a.slides.get(0).get('id') as string)!
    const to = getSlideObjectsCtx(b, b.slides.get(0).get('id') as string)!
    expect(() => copyObjectsTo(from, to, ['x'])).toThrow(/one document/)
  })
})

describe('translateObjects', () => {
  it('moves the frame and the crop rect by the same delta', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [croppedImage('img', 100, 100), rect('r', 0, 0)])
    translateObjects(ctx, [
      { id: 'img', dx: 10, dy: -5 },
      { id: 'r', dx: 1, dy: 1 },
    ])
    const [img, r] = all(ctx) as [ImageObject, RectangleObject]
    expect([img.x, img.y]).toEqual([110, 95])
    expect(img.imageRect).toEqual({ x: 60, y: 75, width: 400, height: 300 })
    expect([r.x, r.y]).toEqual([1, 1])
  })

  it('skips unknown ids and zero deltas', () => {
    const { ctx, undo } = makeCtx()
    addObjects(ctx, [rect('r', 5, 5)])
    undo.stopCapturing()
    translateObjects(ctx, [
      { id: 'missing', dx: 1, dy: 1 },
      { id: 'r', dx: 0, dy: 0 },
    ])
    expect(undo.undoStack).toHaveLength(1)
  })
})

describe('align / distribute carry the crop', () => {
  it('alignObjects shifts imageRect with the frame', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [rect('r', 0, 0), croppedImage('img', 100, 100)])
    alignObjects(ctx, ['r', 'img'], 'left')
    const img = all(ctx)[1] as ImageObject
    expect(img.x).toBe(0)
    expect(img.imageRect).toEqual({ x: -50, y: 80, width: 400, height: 300 })
  })

  it('distributeObjects shifts imageRect with the frame', () => {
    const { ctx } = makeCtx()
    addObjects(ctx, [rect('a', 0, 0), croppedImage('img', 150, 0), rect('c', 1000, 0)])
    distributeObjects(ctx, ['a', 'img', 'c'], 'horizontal')
    const img = all(ctx)[1] as ImageObject
    // span 0..1100, widths 100+200+100 = 400, gap = 350 → img.x = 450.
    expect(img.x).toBe(450)
    expect(img.imageRect).toEqual({ x: 400, y: -20, width: 400, height: 300 })
  })
})
