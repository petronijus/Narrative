/**
 * shapeMask.ts
 *
 * Apply a shape as a clipping mask to an image. Consumes the shape: after
 * the action, the standalone shape is removed and the image carries an
 * `image.mask` field that the renderer uses to clip the visible sprite.
 *
 * This lives in slide-model (not apps/web) because it MUTATES the slide
 * Y.Doc — the "all object-data mutations go through slide-model" invariant.
 * It was previously in `apps/web/src/state/applyShapeMask.ts`, which kept a
 * raw `doc.transact` + `Y.Map`/`Y.Array` edit outside the model layer; that
 * file is now a thin re-export of this module.
 *
 * Behaviour:
 * - The image's frame (x, y, width, height) becomes the SHAPE's bounding
 *   box, so the orange crop-overlay handles operate on the shape's bbox
 *   exactly as they did on the image's old frame.
 * - The image content stays visually pinned to its previous slide-space
 *   position by carrying the previous effective imageRect over to the new
 *   imageRect field unchanged. Only the visible window moves.
 * - Shape rotation is intentionally ignored in v1 — the mask is treated
 *   as if the shape were upright. Resulting frame = AABB of the rotated
 *   shape. Rotation can be re-applied afterwards via the regular object
 *   rotation handle.
 *
 * Maskable shape types: rectangle, ellipse, triangle, polygon, path.
 * Text / image / video / line / arrow are NOT maskable (lines have no
 * fill silhouette; image+video would need re-anchored asset references).
 */

import type * as Y from 'yjs'
import type {
  ImageMask,
  ImageObject,
  NormalizedPathAnchor,
  PathObject,
  SlideObject,
} from '@narrative/shared'
import { LOCAL_ORIGIN, type ObjectsMutationContext } from './mutations.js'

export type MaskableShape = Extract<
  SlideObject,
  { type: 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'path' }
>

export function isMaskableShape(obj: SlideObject): obj is MaskableShape {
  return (
    obj.type === 'rectangle' ||
    obj.type === 'ellipse' ||
    obj.type === 'triangle' ||
    obj.type === 'polygon' ||
    obj.type === 'path'
  )
}

/**
 * Build the ImageMask geometry from a shape, preserving everything the
 * renderer needs to retrace the silhouette inside the new frame's
 * 0..width × 0..height local coords.
 */
export function buildMaskFromShape(shape: MaskableShape): ImageMask {
  switch (shape.type) {
    case 'rectangle':
      return shape.cornerRadius !== undefined
        ? { kind: 'rectangle', cornerRadius: shape.cornerRadius }
        : { kind: 'rectangle' }
    case 'ellipse':
      return { kind: 'ellipse' }
    case 'triangle':
      return { kind: 'triangle' }
    case 'polygon':
      return { kind: 'polygon', sides: shape.sides }
    case 'path':
      return {
        kind: 'path',
        anchors: normalizePathAnchors(shape),
        closed: shape.closed ?? false,
      }
  }
}

/**
 * Normalize a PathObject's anchors to 0..1 coords relative to the path's
 * own AABB (x, y, width, height). This way the anchors stretch with the
 * mask's frame at render time. Anchors and control points are stored
 * relative to the path's (x, y) so we just divide by width / height.
 *
 * Edge case: a path with width or height of 0 would divide-by-zero. We
 * clamp to 1 px to avoid NaNs — the resulting mask is degenerate but the
 * operation can't apply on a zero-sized shape anyway.
 */
function normalizePathAnchors(path: PathObject): NormalizedPathAnchor[] {
  const w = path.width !== 0 ? path.width : 1
  const h = path.height !== 0 ? path.height : 1
  return path.anchors.map((a) => {
    const out: NormalizedPathAnchor = { x: a.x / w, y: a.y / h }
    if (a.cpIn !== undefined) out.cpIn = { x: a.cpIn.x / w, y: a.cpIn.y / h }
    if (a.cpOut !== undefined) out.cpOut = { x: a.cpOut.x / w, y: a.cpOut.y / h }
    return out
  })
}

/**
 * Compute the patch we need to apply to the image so the clipping shape
 * replaces its rectangular frame, while the visible image content stays
 * pinned in slide space.
 */
export function computeMaskedImagePatch(
  image: ImageObject,
  shape: MaskableShape,
): Pick<ImageObject, 'x' | 'y' | 'width' | 'height' | 'imageRect' | 'mask'> {
  // Old effective imageRect (slide coords) — what the user is currently
  // seeing on canvas. We keep this exactly so the image content does not
  // visually jump when the frame moves.
  const ir = image.imageRect ?? {
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
  }

  return {
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    imageRect: ir,
    mask: buildMaskFromShape(shape),
  }
}

/**
 * Apply the shape as a mask to the image inside ONE Yjs transaction so
 * the whole operation is a single undo step.
 *
 * Returns true on success, false if either object id is missing or the
 * shape is not maskable.
 */
export function applyShapeMask(
  ctx: ObjectsMutationContext,
  imageId: string,
  shapeId: string,
): boolean {
  const imageIdx = findIndexById(ctx.objects, imageId)
  const shapeIdx = findIndexById(ctx.objects, shapeId)
  if (imageIdx === -1 || shapeIdx === -1) return false

  const imageMap = ctx.objects.get(imageIdx)
  const shapeMap = ctx.objects.get(shapeIdx)
  const image = readObject(imageMap)
  const shape = readObject(shapeMap)

  if (image.type !== 'image') return false
  if (!isMaskableShape(shape)) return false

  const patch = computeMaskedImagePatch(image, shape)

  ctx.doc.transact(() => {
    // Patch the image first so the renderer sees the new mask before
    // the shape vanishes (avoids a 1-frame flicker where the image
    // shows the old rectangular crop after the shape is gone).
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        imageMap.delete(key)
      } else {
        imageMap.set(key, value)
      }
    }
    // Re-fetch the shape's index because deletes shift indices — but
    // imageMap stays valid as a Y reference even if its index moves.
    const currentShapeIdx = findIndexById(ctx.objects, shapeId)
    if (currentShapeIdx !== -1) {
      ctx.objects.delete(currentShapeIdx, 1)
    }
  }, LOCAL_ORIGIN)

  return true
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function findIndexById(arr: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i).get('id') === id) return i
  }
  return -1
}

function readObject(yMap: Y.Map<unknown>): SlideObject {
  return Object.fromEntries(yMap.entries()) as unknown as SlideObject
}
