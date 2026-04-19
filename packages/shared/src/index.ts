// @narrative/shared — shared types across apps and packages
// Pure TypeScript — no runtime dependencies.

export type {
  BaseSlideObject,
  RectangleObject,
  EllipseObject,
  TextObject,
  SlideObject,
  SlideObjectType,
  SlideObjectPatch,
  Slide,
  ObjectChangeSet,
} from './slide.js'

export type { AnimationPreset, AnimationTrigger, AnimationStep } from './animation.js'

export { isAnimationPreset, isAnimationTrigger } from './animation.js'

export type { PeerUser, PeerCursor, PeerAwarenessState, PeerInfo } from './awareness.js'
export { peerColorFromId } from './awareness.js'
