// @narrative/shared — shared types across apps and packages
// Pure TypeScript — no runtime dependencies.

export { SLIDE_WIDTH, SLIDE_HEIGHT, PPTX_WIDE_EMU_WIDTH, PPTX_WIDE_EMU_HEIGHT } from './canvas.js'

export type { TokenRef } from './slide.js'
export { isTokenRef } from './slide.js'

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
  TextStyleOverrideKey,
  FontWeight,
  TextVerticalAlign,
  TextListStyle,
  ListKind,
  ListNumberFormat,
  ParagraphAttrs,
  ParagraphAttrKey,
  ImageObject,
  VideoObject,
  TableObject,
  TableCell,
  TableDefaults,
  TableBorderStyle,
  TableBorderSegmentKey,
  TableCellEdgeBorders,
  TableCellPadding,
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

export { TEXT_STYLE_OVERRIDE_KEYS, isTextStyleOverrideKey } from './slide.js'
export { MAX_LIST_LEVEL } from './slide.js'
export { hSegKey, vSegKey, getEffectiveBorderSegment } from './slide.js'

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
} from './deck.js'

export { DEFAULT_TRANSITION, DEFAULT_BACKGROUND, computeSlideNumber } from './deck.js'

export type { AnimationPreset, AnimationTrigger, AnimationStep } from './animation.js'

export { isAnimationPreset, isAnimationTrigger } from './animation.js'

export type { PeerUser, PeerCursor, PeerAwarenessState, PeerInfo } from './awareness.js'
export { peerColorFromId } from './awareness.js'

export {
  VIDEO_TRANSCODE_QUEUE,
  type VideoTranscodeJobData,
  type VideoTranscodeResult,
} from './video-queue.js'
