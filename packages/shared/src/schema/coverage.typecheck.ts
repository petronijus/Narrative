/**
 * shared/src/schema/coverage.typecheck.ts
 *
 * Schema coverage check (agentic-layer plan §9.1 item 3). Enforced by
 * `tsc` — i.e. `pnpm --filter @narrative/shared typecheck` — not by vitest:
 * this module has no runtime content and nothing imports it.
 *
 * For every schema below, the schema's OUTPUT type must be *identical* to
 * the hand-written TS type. Adding a property to an interface in slide.ts /
 * deck.ts / animation.ts without adding it to the schema turns the matching
 * entry into a compile error, so agent input can never silently lack a
 * field the model has.
 *
 * How the equality stays honest:
 *
 *   - `Equals` is the "identical types" check (two deferred conditional
 *     types are only mutually assignable when TS's identity relation says
 *     the operands are the same). Mutual assignability would NOT do: under
 *     structural typing `{ a?: number }` and `{}` are assignable both ways,
 *     so a missing OPTIONAL property — the common case — would slip by.
 *
 *   - `exactOptionalPropertyTypes` is on (tsconfig.base.json), so an
 *     interface's `a?: number` means "absent or a number", never
 *     `undefined`. zod v4's `.optional()` infers `a?: number | undefined`,
 *     which is NOT identical. The schemas therefore use `.exactOptional()`
 *     (zod >= 4.2), whose output is exactly `a?: number` — no normalising
 *     mapped type is needed, and a schema that used `.optional()` by
 *     mistake is itself caught here. At runtime `.exactOptional()` also
 *     rejects a present-but-`undefined` key, matching the type.
 *
 *   - Text bodies: the TS types say `string | Y.Text`, schemas parse plain
 *     data, so object types with a text body are compared through the
 *     explicit mapped types in ./plain.ts (body → `string`, everything
 *     else untouched).
 *
 * On failure the error names the tuple entry and prints
 * `{ onlyInSchema: …; onlyInType: … }` — the keys present on one side only.
 * If both are `never`, a key exists on both sides with a different value
 * type or optionality — usually a nested type that changed further down
 * (its own entry above names the key); otherwise compare property by property.
 */

import type { z } from 'zod'
import type {
  BaseSlideObject,
  ArrowObject,
  CornerRadius,
  EllipseObject,
  FillGradientStop,
  FillStyle,
  FontWeight,
  ImageFillStyle,
  ImageMask,
  ImageObject,
  LineCap,
  LineEndpoints,
  LineObject,
  LinearGradientFill,
  ListKind,
  ListNumberFormat,
  NormalizedPathAnchor,
  ObjectHyperlink,
  ObjectRole,
  ComponentProvenance,
  ParagraphAttrs,
  PathAnchor,
  PathObject,
  PolygonObject,
  RadialGradientFill,
  RectangleObject,
  ShadowStyle,
  SlideObjectType,
  StrokeStyleFields,
  TableBorderStyle,
  TableCellEdgeBorders,
  TableCellPadding,
  TableDefaults,
  TextListStyle,
  TextStyleOverrideKey,
  TextVerticalAlign,
  TokenRef,
  TriangleObject,
  VideoObject,
} from '../slide.js'
import type {
  ColorBackground,
  DeckGuide,
  GradientStop,
  ImageBackground,
  LinearGradientBackground,
  RadialGradientBackground,
  SlideBackground,
  SlidePushDirection,
  SlideTransition,
  SlideTransitionKind,
} from '../deck.js'
import type { AnimationPreset, AnimationStep, AnimationTrigger } from '../animation.js'
import type {
  ObjectCreateOverrides,
  ObjectPatch,
  PlainSlideObject,
  PlainSlideObjectOf,
  PlainTableCell,
  PlainTableObject,
  PlainTextObject,
} from './plain.js'
import type * as P from './primitives.js'
import type * as O from './objects.js'
import type * as D from './deck.js'
import type * as A from './animation.js'
import type {
  ObjectCreateInputSchema,
  ObjectPatchInputSchema,
  objectCreateInputSchema,
  objectPatchInputSchema,
} from './input.js'

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

/**
 * `true` when the schema's output is identical to `T`; otherwise an object
 * naming the keys present on only one side, which is what the compiler
 * prints in the error. The object literal is written inline (not behind an
 * alias) so TS expands it in the message instead of printing an alias name.
 */
type Covers<Schema extends z.ZodType, T> =
  Equals<z.output<Schema>, T> extends true
    ? true
    : {
        onlyInSchema: Exclude<keyof z.output<Schema>, keyof T>
        onlyInType: Exclude<keyof T, keyof z.output<Schema>>
      }

type Assert<T extends true> = T

/**
 * Patch / create output for every object type in one mapped pass. The
 * assertion runs on the indexed union of the results (asserting inside the
 * mapped type would check the constraint against the generic `T` instead
 * of each concrete type); a failing type contributes its key diff.
 */
type PatchCoverage = {
  [T in SlideObjectType]: Covers<ObjectPatchInputSchema<T>, ObjectPatch<PlainSlideObjectOf<T>>>
}
type CreateCoverage = {
  [T in SlideObjectType]: Covers<
    ObjectCreateInputSchema<T>,
    ObjectCreateOverrides<PlainSlideObjectOf<T>>
  >
}

/** Exported only so the unused-type lint stays quiet; never used. */
export type SchemaCoverage = [
  // primitives
  Assert<Covers<typeof P.TokenRefSchema, TokenRef>>,
  Assert<Covers<typeof P.ColorValueSchema, number | TokenRef>>,
  Assert<Covers<typeof P.ColorInputSchema, number | TokenRef>>,
  Assert<Covers<typeof P.RgbInputSchema, number>>,

  // slide.ts sub-types
  Assert<Covers<typeof O.ShadowStyleSchema, ShadowStyle>>,
  Assert<Covers<typeof O.ObjectHyperlinkSchema, ObjectHyperlink>>,
  Assert<Covers<typeof O.ObjectRoleSchema, ObjectRole>>,
  Assert<Covers<typeof O.ComponentProvenanceSchema, ComponentProvenance>>,
  Assert<Covers<typeof O.BaseSlideObjectSchema, BaseSlideObject>>,
  Assert<Covers<typeof O.StrokeStyleFieldsSchema, StrokeStyleFields>>,
  Assert<Covers<typeof O.FillGradientStopSchema, FillGradientStop>>,
  Assert<Covers<typeof O.LinearGradientFillSchema, LinearGradientFill>>,
  Assert<Covers<typeof O.RadialGradientFillSchema, RadialGradientFill>>,
  Assert<Covers<typeof O.ImageFillStyleSchema, ImageFillStyle>>,
  Assert<Covers<typeof O.FillStyleSchema, FillStyle>>,
  Assert<Covers<typeof O.CornerRadiusSchema, CornerRadius>>,
  Assert<Covers<typeof O.LineEndpointsSchema, LineEndpoints>>,
  Assert<Covers<typeof O.LineCapSchema, LineCap>>,
  Assert<Covers<typeof O.PathAnchorSchema, PathAnchor>>,
  Assert<Covers<typeof O.FontWeightSchema, FontWeight>>,
  Assert<Covers<typeof O.TextVerticalAlignSchema, TextVerticalAlign>>,
  Assert<Covers<typeof O.TextListStyleSchema, TextListStyle>>,
  Assert<Covers<typeof O.ListKindSchema, ListKind>>,
  Assert<Covers<typeof O.ListNumberFormatSchema, ListNumberFormat>>,
  Assert<Covers<typeof O.ParagraphAttrsSchema, ParagraphAttrs>>,
  Assert<Covers<typeof O.TextStyleOverrideKeySchema, TextStyleOverrideKey>>,
  Assert<Covers<typeof O.NormalizedPathAnchorSchema, NormalizedPathAnchor>>,
  Assert<Covers<typeof O.ImageMaskSchema, ImageMask>>,
  Assert<Covers<typeof O.TableBorderStyleSchema, TableBorderStyle>>,
  Assert<Covers<typeof O.TableCellEdgeBordersSchema, TableCellEdgeBorders>>,
  Assert<Covers<typeof O.TableCellPaddingSchema, TableCellPadding>>,
  Assert<Covers<typeof O.TableCellSchema, PlainTableCell>>,
  Assert<Covers<typeof O.TableDefaultsSchema, TableDefaults>>,

  // slide.ts object variants
  Assert<Covers<typeof O.RectangleObjectSchema, RectangleObject>>,
  Assert<Covers<typeof O.EllipseObjectSchema, EllipseObject>>,
  Assert<Covers<typeof O.TriangleObjectSchema, TriangleObject>>,
  Assert<Covers<typeof O.PolygonObjectSchema, PolygonObject>>,
  Assert<Covers<typeof O.LineObjectSchema, LineObject>>,
  Assert<Covers<typeof O.ArrowObjectSchema, ArrowObject>>,
  Assert<Covers<typeof O.PathObjectSchema, PathObject>>,
  Assert<Covers<typeof O.TextObjectSchema, PlainTextObject>>,
  Assert<Covers<typeof O.ImageObjectSchema, ImageObject>>,
  Assert<Covers<typeof O.VideoObjectSchema, VideoObject>>,
  Assert<Covers<typeof O.TableObjectSchema, PlainTableObject>>,
  // The union: a new SlideObject variant without a schema fails here.
  Assert<Covers<typeof O.SlideObjectSchema, PlainSlideObject>>,
  // The per-type lookup returns the matching variant for every type.
  Assert<
    Equals<
      { [T in SlideObjectType]: z.output<ReturnType<typeof O.slideObjectSchemaFor<T>>> },
      { [T in SlideObjectType]: PlainSlideObjectOf<T> }
    >
  >,

  // deck.ts
  Assert<Covers<typeof D.SlideTransitionKindSchema, SlideTransitionKind>>,
  Assert<Covers<typeof D.SlidePushDirectionSchema, SlidePushDirection>>,
  Assert<Covers<typeof D.SlideTransitionSchema, SlideTransition>>,
  Assert<Covers<typeof D.GradientStopSchema, GradientStop>>,
  Assert<Covers<typeof D.ColorBackgroundSchema, ColorBackground>>,
  Assert<Covers<typeof D.LinearGradientBackgroundSchema, LinearGradientBackground>>,
  Assert<Covers<typeof D.RadialGradientBackgroundSchema, RadialGradientBackground>>,
  Assert<Covers<typeof D.ImageBackgroundSchema, ImageBackground>>,
  Assert<Covers<typeof D.SlideBackgroundSchema, SlideBackground>>,
  Assert<Covers<typeof D.SlideBackgroundInputSchema, SlideBackground>>,
  Assert<Covers<typeof D.DeckGuideSchema, DeckGuide>>,

  // animation.ts
  Assert<Covers<typeof A.AnimationPresetSchema, AnimationPreset>>,
  Assert<Covers<typeof A.AnimationTriggerSchema, AnimationTrigger>>,
  Assert<Covers<typeof A.AnimationStepSchema, AnimationStep>>,

  // agent input: the lookup functions return the declared schema types,
  // and those parse to exactly ObjectPatch / ObjectCreateOverrides.
  Assert<Equals<ReturnType<typeof objectPatchInputSchema<'text'>>, ObjectPatchInputSchema<'text'>>>,
  Assert<
    Equals<ReturnType<typeof objectCreateInputSchema<'table'>>, ObjectCreateInputSchema<'table'>>
  >,
  Assert<PatchCoverage[SlideObjectType]>,
  Assert<CreateCoverage[SlideObjectType]>,
]
