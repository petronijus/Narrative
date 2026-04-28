// @narrative/shared — shared types across apps and packages
// Pure TypeScript — no runtime dependencies.

export type {
  BaseSlideObject,
  RectangleObject,
  EllipseObject,
  TriangleObject,
  PolygonObject,
  LineObject,
  ArrowObject,
  LineCap,
  LineEndpoints,
  PathObject,
  PathAnchor,
  TextObject,
  FontWeight,
  TextVerticalAlign,
  TextListStyle,
  ImageObject,
  VideoObject,
  SlideObject,
  SlideObjectType,
  SlideObjectPatch,
  ObjectChangeSet,
  StrokeStyleFields,
  CornerRadius,
  ShadowStyle,
  FillGradientStop,
  LinearGradientFill,
  RadialGradientFill,
  ImageFillStyle,
  FillStyle,
  ObjectHyperlink,
  ImageMask,
  NormalizedPathAnchor,
} from './slide.js'

export type {
  SlideTransitionKind,
  SlidePushDirection,
  SlideTransition,
  Slide,
  GradientStop,
  ColorBackground,
  LinearGradientBackground,
  RadialGradientBackground,
  ImageBackground,
  SlideBackground,
  DeckGuide,
  DeckFontEntry,
} from './deck.js'

export { DEFAULT_TRANSITION, DEFAULT_BACKGROUND } from './deck.js'

export type { AnimationPreset, AnimationTrigger, AnimationStep } from './animation.js'

export { isAnimationPreset, isAnimationTrigger } from './animation.js'

export type { PeerUser, PeerCursor, PeerAwarenessState, PeerInfo } from './awareness.js'
export { peerColorFromId } from './awareness.js'

export {
  VIDEO_TRANSCODE_QUEUE,
  type VideoTranscodeJobData,
  type VideoTranscodeResult,
} from './video-queue.js'
