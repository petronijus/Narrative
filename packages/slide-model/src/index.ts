/**
 * @narrative/slide-model — public API
 *
 * Single import point for all state/Yjs operations.
 * Renderer and editor-ui must not import Y.Doc directly —
 * everything goes through this API (see ADR-0003).
 */

// Registry
export { registerObjectType, getObjectTypeDef, listRegisteredTypes } from './registry.js'
export type { ObjectTypeDef } from './registry.js'

// Y.Doc factory (M9: multi-slide schema)
export { createSlideDoc, hydrateSlideDoc } from './yDoc.js'
export type { SlideDocHandles } from './yDoc.js'

// Mutations — objects
export {
  LOCAL_ORIGIN,
  addObject,
  removeObject,
  updateObject,
  createObjectOfType,
  duplicateObject,
  bulkUpdateObjects,
} from './mutations.js'
export type {
  ObjectsMutationContext,
  /** @deprecated Use ObjectsMutationContext */
  MutationContext,
  BulkUpdate,
} from './mutations.js'

// Mutations — animations (M6)
export {
  addAnimation,
  removeAnimation,
  updateAnimation,
  reorderAnimations,
} from './animationMutations.js'
export type {
  AnimationsMutationContext,
  /** @deprecated Use AnimationsMutationContext */
  AnimationMutationContext,
} from './animationMutations.js'

// Deck-level mutation context (M9)
export type { SlideMutationContext, DeckMutationContext } from './slideMutationContext.js'

// Slide CRUD + scoped context accessors (M9)
export {
  addSlide,
  removeSlide,
  moveSlide,
  updateSlideTransition,
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
} from './slides.js'

// Bindings — objects
export { yMapToPlainObject, plainObjectToYMap } from './bindings.js'

// Bindings — animations (M6)
export {
  yMapToAnimationStep,
  animationStepToYMap,
  animationStepToYMapInDoc,
} from './animationBindings.js'

// Undo
export { createUndoManager } from './undo.js'

// Awareness helpers (M8)
export { generatePeerId, toPeerInfo, peerColorFromId } from './awareness.js'

// Observer — slides (M9)
export {
  subscribeToSlides,
  subscribeToSlideObjects,
  subscribeToSlideObjectsWithFlush,
  subscribeToSlideAnimations,
} from './slideObserve.js'
export type { SlideSummary, ObjectChangeSet } from './slideObserve.js'

// Observer — objects (deprecated, backward compat — remove in M10)
export {
  subscribeToObjects,
  subscribeToObjectChanges,
  subscribeToObjectChangesWithFlush,
} from './observe.js'

// Observer — animations (deprecated, backward compat — remove in M10)
export { subscribeToAnimations } from './animationObserve.js'

// ---------------------------------------------------------------------------
// Builtin object type registrations
// ---------------------------------------------------------------------------
// Importing this module (index) guarantees builtin types are registered.

import { registerObjectType } from './registry.js'
import type { RectangleObject, EllipseObject, TextObject } from '@narrative/shared'

registerObjectType<RectangleObject>({
  type: 'rectangle',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 200,
    height: 150,
    fill: 0x4060e0,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<EllipseObject>({
  type: 'ellipse',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 180,
    fill: 0xe06040,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<TextObject>({
  type: 'text',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 240,
    height: 40,
    text: 'Text',
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
    rotation: 0,
    opacity: 1,
  }),
})
