/**
 * shared/src/schema/animation.ts
 *
 * Runtime schema for the animation DSL (`../animation.ts`), with per-preset
 * `params` validation derived from what each factory in
 * packages/animation/src/presets/ actually reads.
 */

import { z } from 'zod'
import type { AnimationPreset } from '../animation.js'
import { FiniteNumberSchema, IdSchema, NonNegativeNumberSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Compiler clamps (mirrored)
// ---------------------------------------------------------------------------
//
// packages/animation/src/compiler.ts `clampStep` silently caps these before
// anything reaches GSAP. @narrative/shared cannot import the animation
// package (the dependency runs the other way), so the values are mirrored
// here; the boundary REJECTS what the compiler would silently rewrite, so an
// agent learns its value was out of range instead of seeing a different
// animation than it asked for.

/** `MAX_STEP_DURATION_S` in compiler.ts. */
export const MAX_STEP_DURATION_S = 600
/** `MAX_STEP_DELAY_S` in compiler.ts. */
export const MAX_STEP_DELAY_S = 600
/**
 * `MAX_REPEAT` in compiler.ts. GSAP's `-1` ("forever") is what the clamp
 * exists to defuse, so it is not accepted at the boundary at all.
 */
export const MAX_REPEAT = 20

export const AnimationPresetSchema = z.enum([
  'fadeIn',
  'fadeOut',
  'slideIn',
  'slideOut',
  'scaleIn',
  'scaleOut',
  'zoomIn',
  'rotateIn',
  'bounceIn',
  'flipIn',
  'popIn',
  'dissolveIn',
  'wipeIn',
  'moveTo',
  'rotateTo',
])

export const AnimationTriggerSchema = z.enum([
  'onEnter',
  'onClick',
  'withPrevious',
  'afterPrevious',
])

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/**
 * GSAP core ease names, as registered in gsap-core.js (`_insertEase`):
 * the power family and its aliases, plus sine/expo/circ/bounce/back/
 * elastic, each with an optional `.in` / `.out` / `.inOut`; `none`; `back`
 * and `elastic` accept numeric config args (`back.out(1.7)` is popIn's
 * default); `steps(n)`. GSAP resolves an unknown name to its default ease
 * WITHOUT an error, so a typo would silently animate with the wrong curve —
 * hence the check. CustomEase is not registered anywhere in the app.
 */
const EASE_NAME =
  '(?:linear|quad|cubic|quart|quint|strong|power[0-4]|sine|expo|circ|bounce|back|elastic)'
const EASE_VARIANT = '(?:\\.(?:in|out|inOut))?'
const EASE_NUM = '\\s*-?(?:\\d+\\.?\\d*|\\.\\d+)\\s*'
const EASING_PATTERN = new RegExp(
  `^(?:none|${EASE_NAME}${EASE_VARIANT}|(?:back|elastic)${EASE_VARIANT}\\(${EASE_NUM}(?:,${EASE_NUM})*\\)|steps\\(\\s*\\d+\\s*\\))$`,
)

export const EasingSchema = z.string().regex(EASING_PATTERN, {
  message: 'Expected a GSAP ease such as "power2.out", "sine.inOut", "back.out(1.7)" or "none"',
})

// ---------------------------------------------------------------------------
// Per-preset params
// ---------------------------------------------------------------------------

/** Every step may carry `repeat` — the compiler reads it for any preset. */
const repeatShape = {
  repeat: z.number().int().min(0).max(MAX_REPEAT).exactOptional(),
}

const DirectionSchema = z.enum(['up', 'down', 'left', 'right'])

/** For presets whose factory reads nothing but the shared step fields. */
const noParams = z.strictObject(repeatShape)

/**
 * The params each preset factory understands. Strict: a key the preset
 * does not read is an error (usually a param meant for another preset).
 * `satisfies Record<AnimationPreset, …>` makes a new preset without an
 * entry a compile error.
 */
export const ANIMATION_PRESET_PARAMS_SCHEMAS = {
  fadeIn: noParams,
  fadeOut: noParams,
  // slideIn/slideOut.ts: direction defaults to 'up', distance to 100 px.
  // The Inspector only writes distance >= 0 (a negative one reverses the
  // direction, which `direction` already expresses).
  slideIn: z.strictObject({
    direction: DirectionSchema.exactOptional(),
    distance: NonNegativeNumberSchema.exactOptional(),
    ...repeatShape,
  }),
  slideOut: z.strictObject({
    direction: DirectionSchema.exactOptional(),
    distance: NonNegativeNumberSchema.exactOptional(),
    ...repeatShape,
  }),
  scaleIn: noParams,
  scaleOut: noParams,
  // zoomIn.ts ignores fromScale <= 0 and falls back to 2.
  zoomIn: z.strictObject({ fromScale: z.number().positive().exactOptional(), ...repeatShape }),
  // rotateIn.ts: starting offset in RADIANS, default -π/2.
  rotateIn: z.strictObject({ angle: FiniteNumberSchema.exactOptional(), ...repeatShape }),
  bounceIn: noParams,
  // flipIn.ts: anything but 'y' means 'x'.
  flipIn: z.strictObject({ axis: z.enum(['x', 'y']).exactOptional(), ...repeatShape }),
  popIn: noParams,
  dissolveIn: noParams,
  // wipeIn.ts: default 'left'.
  wipeIn: z.strictObject({ direction: DirectionSchema.exactOptional(), ...repeatShape }),
  // moveTo.ts falls back to "stay where you are" without a target, which
  // makes the step a no-op; the Inspector always seeds both. Required here.
  // Slide-space px of the destination (the Pixi pivot, i.e. the centre —
  // see MoveToTargetOverlay).
  moveTo: z.strictObject({
    targetX: FiniteNumberSchema,
    targetY: FiniteNumberSchema,
    ...repeatShape,
  }),
  // rotateTo.ts: absolute target in DEGREES, default 360.
  rotateTo: z.strictObject({ angleDeg: FiniteNumberSchema.exactOptional(), ...repeatShape }),
} as const satisfies Record<AnimationPreset, z.ZodType<Record<string, unknown>>>

/** Parsed params of one preset. */
export type AnimationPresetParams<P extends AnimationPreset> = z.output<
  (typeof ANIMATION_PRESET_PARAMS_SCHEMAS)[P]
>

// ---------------------------------------------------------------------------
// AnimationStep
// ---------------------------------------------------------------------------

/**
 * One DSL step. `params` keeps the TS type's `Record<string, unknown>`
 * shape (so the output type stays exactly `AnimationStep`), and a
 * refinement validates it against the chosen preset's params schema,
 * reporting issues under `params.<key>`.
 */
export const AnimationStepSchema = z
  .strictObject({
    id: IdSchema,
    objectId: IdSchema,
    preset: AnimationPresetSchema,
    trigger: AnimationTriggerSchema,
    duration: z.number().positive().max(MAX_STEP_DURATION_S),
    delay: z.number().min(0).max(MAX_STEP_DELAY_S),
    easing: EasingSchema,
    params: z.record(z.string(), z.unknown()).exactOptional(),
  })
  .superRefine((step, ctx) => {
    const paramsSchema = ANIMATION_PRESET_PARAMS_SCHEMAS[step.preset]
    const result = paramsSchema.safeParse(step.params ?? {})
    if (result.success) return
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: `${step.preset}: ${issue.message}`,
        path: ['params', ...issue.path],
        input: step.params,
      })
    }
  })
