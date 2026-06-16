/**
 * state/applyShapeMask.ts
 *
 * Thin re-export. The actual shape-as-image-mask mutation now lives in
 * `@narrative/slide-model` (`src/shapeMask.ts`) because it mutates the slide
 * Y.Doc — the "all object-data mutations go through slide-model" invariant.
 * This file is kept only so existing imports (and their test mocks) that
 * reference `'../state/applyShapeMask.js'` keep resolving unchanged.
 */

export {
  applyShapeMask,
  isMaskableShape,
  buildMaskFromShape,
  computeMaskedImagePatch,
  type MaskableShape,
} from '@narrative/slide-model'
