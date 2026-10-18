// @narrative/shared — shared types across apps and packages
// Pure TypeScript, except ./schema, which carries the zod runtime schemas
// used to validate agent input (see schema/index.ts).

export { SLIDE_WIDTH, SLIDE_HEIGHT, PPTX_WIDE_EMU_WIDTH, PPTX_WIDE_EMU_HEIGHT } from './canvas.js'
export type { ShapePoint } from './shapeGeometry.js'
export { polygonSides, triangleVertices, regularPolygonVertices } from './shapeGeometry.js'

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
  TextAutofit,
  TextListLevel,
  TextListStyle,
  ListKind,
  ListNumberFormat,
  ParagraphAttrs,
  ParagraphAttrKey,
  ImageObject,
  ImageFocus,
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
  ObjectRole,
  ComponentProvenance,
  ImageMask,
  NormalizedPathAnchor,
} from './slide.js'

export { TEXT_STYLE_OVERRIDE_KEYS, isTextStyleOverrideKey } from './slide.js'
export { MAX_LIST_LEVEL, MAX_PATH_ANCHORS, OBJECT_ROLES } from './slide.js'
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
  DeckMeta,
  SlideLayoutRef,
  SlideBrief,
  SlideClaim,
} from './deck.js'

export { DEFAULT_TRANSITION, DEFAULT_BACKGROUND, computeSlideNumber } from './deck.js'

export type { AnimationPreset, AnimationTrigger, AnimationStep } from './animation.js'

export { isAnimationPreset, isAnimationTrigger } from './animation.js'
export type { TimedAnimationStep } from './animationTiming.js'
export { layoutAnimationSteps } from './animationTiming.js'

export type {
  PeerUser,
  PeerCursor,
  PeerAwarenessState,
  PeerAgentInfo,
  PeerAgentWireInfo,
  PeerInfo,
  AgentPrincipalMessage,
} from './awareness.js'
export {
  peerColorFromId,
  agentPrincipalKeyInput,
  AGENT_PRINCIPAL_KEY_LENGTH,
  AGENT_PRINCIPAL_MESSAGE_TYPE,
  parseAgentPrincipalMessage,
  PEER_USER_NAME_MAX,
  sanitizePeerLabel,
} from './awareness.js'

export { sanitizeHref } from './sanitize.js'

export { rotationFromDegrees, rotationToDegrees } from './rotation.js'

export {
  VIDEO_TRANSCODE_QUEUE,
  videoOutputPrefix,
  type VideoTranscodeJobData,
  type VideoTranscodeResult,
} from './video-queue.js'

export {
  RENDER_QUEUE,
  RENDER_WIDTH,
  RENDER_HEIGHT,
  renderFailureMessage,
  parseRenderFailure,
  type RenderJobData,
  type RenderJobResult,
  type RenderedSlide,
  type RenderFailureReason,
  type RenderUpload,
  type RenderTarget,
  type RenderExportJob,
  type RenderLookJob,
  type RenderLookSpec,
  type RenderedLook,
  type RenderPage,
  type RenderPageLookSpec,
  type TextOverflow,
  type GrownText,
  renderPageName,
  renderPagePath,
  LOOK_MAX_EDGE,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  LOOK_MAX_PIXELS,
} from './render-queue.js'

export {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_IPC,
  DESKTOP_MENU_ACCELERATORS,
  DESKTOP_MENU_LABEL_MAX,
  DESKTOP_MENU_MAX_ITEMS,
  DESKTOP_OPEN_FILE_CHUNK,
  type DesktopIpcChannel,
  type DesktopRole,
  type DesktopNativeEdit,
  type DesktopInfo,
  type DesktopMenuItem,
  type DesktopMenuEntry,
  type DesktopMenuSection,
  type DesktopOpenedFile,
  type DesktopScreenRect,
  type NarrativeDesktopBridge,
} from './desktop.js'

export * from './schema/index.js'
export { buildImagePdf, jpegInfo, type JpegInfo, type PdfOptions, type PdfPage } from './pdf.js'
export {
  CREDENTIAL_PREFIXES,
  looksLikeNarrativeCredential,
  maskCredentials,
  maskShareTokens,
} from './credentialPatterns.js'
export {
  FILTERED,
  TELEMETRY_DATA_COLLECTION,
  scrubString,
  scrubTelemetryPayload,
} from './telemetryScrub.js'
export {
  PERF_COUNTS_KEY,
  perfCount,
  perfCountFor,
  perfCountersOn,
  readPerfCounters,
  resetPerfCounters,
  startPerfCounters,
  stopPerfCounters,
} from './perfCounters.js'
