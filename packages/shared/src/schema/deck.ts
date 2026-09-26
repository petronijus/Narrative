/**
 * shared/src/schema/deck.ts
 *
 * Runtime schemas for the deck-level types in `../deck.ts`: slide
 * transitions, slide backgrounds and deck guides. Same conventions as
 * ./objects.ts — strict objects, exact optionals, a storage variant plus a
 * colour-input variant built from one factory.
 */

import { z } from 'zod'
import {
  ColorIntSchema,
  FiniteNumberSchema,
  IdSchema,
  NonNegativeNumberSchema,
  RgbInputSchema,
  UnitIntervalSchema,
} from './primitives.js'
import { MAX_GRADIENT_STOPS, MIN_GRADIENT_STOPS } from './objects.js'
import { MAX_STEP_DURATION_S } from './animation.js'

export const SlideTransitionKindSchema = z.enum(['none', 'fade', 'push', 'cube', 'magic'])
export const SlidePushDirectionSchema = z.enum(['left', 'right', 'up', 'down'])

/**
 * Transition duration cap, in ms. The transition runners
 * (packages/animation/src/transitions/*) have NO clamp of their own — unlike
 * animation steps, which the compiler caps at `MAX_STEP_DURATION_S` as a
 * client-side DoS guard. A multi-hour transition would freeze present mode
 * for every viewer just the same, so the boundary applies the step cap.
 */
export const MAX_TRANSITION_DURATION_MS = MAX_STEP_DURATION_S * 1000

export const SlideTransitionSchema = z.strictObject({
  kind: SlideTransitionKindSchema,
  // Not forced to 0 for kind 'none' despite the type comment: existing
  // decks carry e.g. `{ kind: 'none', durationMs: 300 }` (see the PPTX
  // round-trip matrix) and the 'none' runner never reads the duration.
  durationMs: NonNegativeNumberSchema.max(MAX_TRANSITION_DURATION_MS),
  direction: SlidePushDirectionSchema.exactOptional(),
})

export const DeckGuideSchema = z.strictObject({
  id: IdSchema,
  orientation: z.enum(['horizontal', 'vertical']),
  position: FiniteNumberSchema,
})

/** A schema whose output is a stored `0xRRGGBB` integer. */
type RgbSlot = z.ZodType<number>

function buildBackgroundSchemas<R extends RgbSlot>(rgb: R) {
  const GradientStopSchema = z.strictObject({
    offset: UnitIntervalSchema,
    color: rgb,
    alpha: UnitIntervalSchema.exactOptional(),
  })
  // Slide backgrounds share the Inspector's GradientStopsEditor with object
  // fills, so the same 2..10 stop bounds apply.
  const stops = z.array(GradientStopSchema).min(MIN_GRADIENT_STOPS).max(MAX_GRADIENT_STOPS)

  const ColorBackgroundSchema = z.strictObject({
    kind: z.literal('color'),
    color: rgb,
    alpha: UnitIntervalSchema.exactOptional(),
  })
  const LinearGradientBackgroundSchema = z.strictObject({
    kind: z.literal('linearGradient'),
    angleDeg: FiniteNumberSchema,
    stops,
  })
  const RadialGradientBackgroundSchema = z.strictObject({
    kind: z.literal('radialGradient'),
    centerX: UnitIntervalSchema,
    centerY: UnitIntervalSchema,
    radius: NonNegativeNumberSchema,
    stops,
  })
  const ImageBackgroundSchema = z.strictObject({
    kind: z.literal('image'),
    assetId: IdSchema,
    fit: z.enum(['cover', 'contain']),
    dim: UnitIntervalSchema.exactOptional(),
  })
  const SlideBackgroundSchema = z.discriminatedUnion('kind', [
    ColorBackgroundSchema,
    LinearGradientBackgroundSchema,
    RadialGradientBackgroundSchema,
    ImageBackgroundSchema,
  ])
  return {
    GradientStopSchema,
    ColorBackgroundSchema,
    LinearGradientBackgroundSchema,
    RadialGradientBackgroundSchema,
    ImageBackgroundSchema,
    SlideBackgroundSchema,
  }
}

const storage = buildBackgroundSchemas(ColorIntSchema)

export const GradientStopSchema = storage.GradientStopSchema
export const ColorBackgroundSchema = storage.ColorBackgroundSchema
export const LinearGradientBackgroundSchema = storage.LinearGradientBackgroundSchema
export const RadialGradientBackgroundSchema = storage.RadialGradientBackgroundSchema
export const ImageBackgroundSchema = storage.ImageBackgroundSchema
export const SlideBackgroundSchema = storage.SlideBackgroundSchema

/**
 * Agent-facing slide background: same shape and output as
 * {@link SlideBackgroundSchema}, but colours also accept `'#RRGGBB'` /
 * `'#RGB'`.
 */
export const SlideBackgroundInputSchema =
  buildBackgroundSchemas(RgbInputSchema).SlideBackgroundSchema
