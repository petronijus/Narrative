/**
 * shapeMask.test.ts
 *
 * Locks the shape-as-image-mask mutation after it moved out of apps/web into
 * slide-model (the "mutations live in slide-model" invariant). Asserts the
 * happy path (image adopts the shape's bbox + a mask, shape is consumed) and
 * the guard cases (non-image / non-maskable / missing ids → no-op false).
 */

import { describe, it, expect } from 'vitest'
import { createSlideDoc } from './yDoc.js'
import { addObject, type ObjectsMutationContext } from './mutations.js'
import { getSlideObjectsCtx } from './slides.js'
import { applyShapeMask, isMaskableShape } from './shapeMask.js'
import { yMapToPlainObject } from './bindings.js'
import type { ImageObject, RectangleObject, LineObject, ImageMask } from '@narrative/shared'

function makeCtx(): ObjectsMutationContext {
  const { doc, slides } = createSlideDoc()
  const firstSlideId = slides.get(0).get('id') as string
  const ctx = getSlideObjectsCtx({ doc, slides }, firstSlideId)
  if (ctx === null) throw new Error('makeCtx: no slide-0 objects ctx')
  return ctx
}

const image: ImageObject = {
  id: 'img1',
  type: 'image',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  assetId: 'asset-1',
}

const rect: RectangleObject = {
  id: 'shp1',
  type: 'rectangle',
  x: 25,
  y: 30,
  width: 40,
  height: 60,
  fill: 0x000000,
  rotation: 0,
  opacity: 1,
  cornerRadius: 8,
}

describe('applyShapeMask', () => {
  it('moves the image frame to the shape bbox, sets the mask, and consumes the shape', () => {
    const ctx = makeCtx()
    addObject(ctx, image)
    addObject(ctx, rect)

    const ok = applyShapeMask(ctx, 'img1', 'shp1')
    expect(ok).toBe(true)

    // Shape is gone; only the image remains.
    expect(ctx.objects.length).toBe(1)
    const result = yMapToPlainObject<ImageObject>(ctx.objects.get(0))
    expect(result.id).toBe('img1')
    // Frame adopts the shape's bbox.
    expect(result.x).toBe(25)
    expect(result.y).toBe(30)
    expect(result.width).toBe(40)
    expect(result.height).toBe(60)
    // Mask matches the rounded rectangle.
    expect(result.mask).toEqual<ImageMask>({ kind: 'rectangle', cornerRadius: 8 })
    // imageRect pins the previously-visible content (the image's old frame).
    expect(result.imageRect).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('returns false and mutates nothing when the shape is not maskable (line)', () => {
    const ctx = makeCtx()
    addObject(ctx, image)
    const line: LineObject = {
      id: 'shp1',
      type: 'line',
      x: 0,
      y: 0,
      width: 50,
      height: 0,
      rotation: 0,
      opacity: 1,
      p1: { x: 0, y: 0 },
      p2: { x: 50, y: 0 },
      stroke: 0x000000,
      strokeWidth: 2,
    }
    addObject(ctx, line)

    expect(applyShapeMask(ctx, 'img1', 'shp1')).toBe(false)
    // Both objects survive untouched.
    expect(ctx.objects.length).toBe(2)
    expect(yMapToPlainObject<ImageObject>(ctx.objects.get(0)).mask).toBeUndefined()
  })

  it('returns false when an id is missing', () => {
    const ctx = makeCtx()
    addObject(ctx, image)
    addObject(ctx, rect)
    expect(applyShapeMask(ctx, 'nope', 'shp1')).toBe(false)
    expect(applyShapeMask(ctx, 'img1', 'nope')).toBe(false)
    expect(ctx.objects.length).toBe(2)
  })

  it('isMaskableShape accepts shapes, rejects line/image/text', () => {
    expect(isMaskableShape(rect)).toBe(true)
    expect(isMaskableShape(image)).toBe(false)
  })
})
