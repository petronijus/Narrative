/**
 * duplicateObjects group remapping + crop-carrying translation
 * (translateObjects, alignObjects, distributeObjects).
 */

import { describe, expect, it } from 'vitest'
import type { ImageObject, RectangleObject } from '@narrative/shared'
import { createSlideDoc } from './yDoc.js'
import { getSlideObjectsCtx } from './slides.js'
import { yMapToPlainObject } from './bindings.js'
import {
  addObjects,
  alignObjects,
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
