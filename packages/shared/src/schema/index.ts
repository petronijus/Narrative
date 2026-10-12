/**
 * shared/src/schema — runtime (zod) schemas for everything an agent can
 * send into the slide model. Storage schemas mirror the TS types exactly
 * (compile-time enforced by ./coverage.typecheck.ts); the input schemas in
 * ./input.ts are what command handlers validate agent input against.
 */

export {
  FiniteNumberSchema,
  NonNegativeNumberSchema,
  PositiveNumberSchema,
  UnitIntervalSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  IdSchema,
  ColorIntSchema,
  TokenRefSchema,
  ColorTokenRefSchema,
  ColorValueSchema,
  HexColorStringSchema,
  RgbInputSchema,
  ColorInputSchema,
  PointSchema,
} from './primitives.js'

export {
  MIN_GRADIENT_STOPS,
  MAX_GRADIENT_STOPS,
  MIN_POLYGON_SIDES,
  MAX_POLYGON_SIDES,
  ObjectHyperlinkSchema,
  ObjectRoleSchema,
  ComponentProvenanceSchema,
  SlotNameSchema,
  MAX_SLOT_NAME,
  CornerRadiusSchema,
  LineCapSchema,
  LineEndpointsSchema,
  PathAnchorSchema,
  FontWeightSchema,
  TextVerticalAlignSchema,
  TextAutofitSchema,
  TextListStyleSchema,
  ListKindSchema,
  ListNumberFormatSchema,
  ParagraphAttrsSchema,
  TextStyleOverrideKeySchema,
  NormalizedPathAnchorSchema,
  ImageMaskSchema,
  TableCellPaddingSchema,
  ShadowStyleSchema,
  BaseSlideObjectSchema,
  StrokeStyleFieldsSchema,
  FillGradientStopSchema,
  LinearGradientFillSchema,
  RadialGradientFillSchema,
  ImageFillStyleSchema,
  FillStyleSchema,
  RectangleObjectSchema,
  EllipseObjectSchema,
  TriangleObjectSchema,
  PolygonObjectSchema,
  LineObjectSchema,
  ArrowObjectSchema,
  PathObjectSchema,
  TextObjectSchema,
  ImageObjectSchema,
  VideoObjectSchema,
  TableBorderStyleSchema,
  TableCellEdgeBordersSchema,
  TableCellSchema,
  TableDefaultsSchema,
  TableObjectSchema,
  SlideObjectSchema,
  slideObjectSchemaFor,
  type SlideObjectSchemas,
} from './objects.js'

export {
  SlideTransitionKindSchema,
  SlidePushDirectionSchema,
  MAX_TRANSITION_DURATION_MS,
  SlideTransitionSchema,
  DeckGuideSchema,
  GradientStopSchema,
  ColorBackgroundSchema,
  LinearGradientBackgroundSchema,
  RadialGradientBackgroundSchema,
  ImageBackgroundSchema,
  SlideBackgroundSchema,
  SlideBackgroundInputSchema,
} from './deck.js'

export {
  MAX_STEP_DURATION_S,
  MAX_STEP_DELAY_S,
  MAX_REPEAT,
  AnimationPresetSchema,
  AnimationTriggerSchema,
  EasingSchema,
  ANIMATION_PRESET_PARAMS_SCHEMAS,
  AnimationStepSchema,
  type AnimationPresetParams,
} from './animation.js'

export {
  objectPatchInputSchema,
  objectCreateInputSchema,
  type ObjectPatchInputSchema,
  type ObjectCreateInputSchema,
} from './input.js'

export type {
  PlainTextObject,
  PlainTableCell,
  PlainTableObject,
  PlainSlideObject,
  PlainSlideObjectOf,
  ObjectPatch,
  ObjectCreateOverrides,
} from './plain.js'
