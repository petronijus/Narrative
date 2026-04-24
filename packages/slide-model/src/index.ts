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
  addObjects,
  removeObject,
  updateObject,
  createObjectOfType,
  duplicateObject,
  bulkUpdateObjects,
  moveObjectsLayer,
  moveObjectToIndex,
  alignObjects,
  distributeObjects,
  groupObjects,
  ungroupObjects,
  getGroupMembers,
} from './mutations.js'
export type {
  ObjectsMutationContext,
  /** @deprecated Use ObjectsMutationContext */
  MutationContext,
  BulkUpdate,
  LayerMove,
  AlignAxis,
  DistributeAxis,
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
  moveSlidesBlock,
  updateSlideTransition,
  updateSlideBackground,
  setSlideName,
  setSlideSkipped,
  setSlideIndent,
  setSlideCollapsed,
  listSlides,
  getSlideObjectsCtx,
  getSlideAnimationsCtx,
  getSlideNotes,
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
import type {
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  PathObject,
  TextObject,
  ImageObject,
  VideoObject,
} from '@narrative/shared'

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

registerObjectType<TriangleObject>({
  type: 'triangle',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 160,
    fill: 0x40b060,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<PolygonObject>({
  type: 'polygon',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 180,
    fill: 0xe0a040,
    rotation: 0,
    opacity: 1,
    sides: 5,
  }),
})

registerObjectType<LineObject>({
  type: 'line',
  defaultProps: () => ({
    x: 100,
    y: 200,
    width: 200,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0xffffff,
    strokeWidth: 3,
    p1: { x: 0, y: 0 },
    p2: { x: 200, y: 0 },
    startCap: 'none',
    endCap: 'none',
  }),
})

registerObjectType<ArrowObject>({
  type: 'arrow',
  defaultProps: () => ({
    x: 100,
    y: 200,
    width: 200,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0xffffff,
    strokeWidth: 3,
    p1: { x: 0, y: 0 },
    p2: { x: 200, y: 0 },
    startCap: 'none',
    endCap: 'arrow',
  }),
})

registerObjectType<PathObject>({
  type: 'path',
  defaultProps: () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    opacity: 1,
    stroke: 0xffffff,
    strokeWidth: 3,
    anchors: [],
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

/**
 * Image object type.
 * NOTE: callers MUST provide assetId via createObjectOfType overrides after a successful upload.
 * Creating an image object without assetId yields a broken placeholder — intentional for M11.
 * Editor-ui calls createObjectOfType('image', { assetId, width, height }) on upload completion.
 */
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

/**
 * Video object type.
 * NOTE: callers MUST provide assetId via createObjectOfType overrides after upload.
 * Creating a video object without assetId yields a broken placeholder — upload and transcode pending.
 * Media agent phase 2 sets kind='video', transcode_status='pending' on finalize.
 * Editor-ui calls createObjectOfType('video', { assetId }) once the upload completes.
 * The renderer must check transcodeStatus via /api/media/:id/video-info before playback.
 */
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
