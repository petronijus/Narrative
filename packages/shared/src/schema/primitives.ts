/**
 * shared/src/schema/primitives.ts
 *
 * Leaf schemas every slide-model schema is built from: numbers with the
 * ranges the renderer actually honours, ids, colours and token refs.
 *
 * Why a separate folder from `slide.ts`: that file must stay free of
 * runtime imports (it is pulled into every bundle as pure types). Schemas
 * need zod at runtime, so they live here and point back at the types only
 * through `import type`.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Any finite number. zod v4's `z.number()` already rejects `NaN` and
 * `±Infinity`, which is exactly the guard we want everywhere: a NaN
 * coordinate or an infinite width poisons Pixi's transform maths and the
 * PPTX writer alike, and JSON cannot carry either value faithfully anyway.
 */
export const FiniteNumberSchema = z.number()

/** Finite and `>= 0` — sizes, blur radii, stroke widths, paddings, spacings. */
export const NonNegativeNumberSchema = z.number().nonnegative()

/** Finite and `> 0` — font sizes, line-height multipliers, grid tracks. */
export const PositiveNumberSchema = z.number().positive()

/**
 * `[0, 1]` — every opacity / `*Alpha` field, gradient offsets, normalised
 * centres. The renderer multiplies these straight into Pixi alpha, where a
 * value outside the interval either clips silently or inverts blending.
 */
export const UnitIntervalSchema = z.number().min(0).max(1)

/** Non-negative safe integer — table indexes, merge pointers. */
export const NonNegativeIntSchema = z.number().int().nonnegative()

/** Positive safe integer — spans, list `startAt`. */
export const PositiveIntSchema = z.number().int().positive()

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Object / slide / step / asset id. The slide model generates nanoids, but
 * imported decks keep their own ids, so the only invariant worth enforcing
 * is "not empty" — an empty id cannot be looked up and collides with the
 * "no value" sentinel several readers use.
 */
export const IdSchema = z.string().min(1)

// ---------------------------------------------------------------------------
// Colours + token refs
// ---------------------------------------------------------------------------

/**
 * Stored colour: a 24-bit `0xRRGGBB` integer. No alpha channel — alpha
 * always travels in a sibling `*Alpha` field.
 */
export const ColorIntSchema = z.number().int().min(0).max(0xffffff)

/**
 * Token ids are `nanoid(10)` (FolderDocProvider), so the id alphabet is
 * nanoid's URL-safe set. The category list mirrors `TokenRef`'s doc comment.
 */
const TOKEN_REF_PATTERN = /^(colors|textStyles|effectStyles)\.[A-Za-z0-9_-]+$/

/**
 * Colour-bearing token categories. `resolveTokenValue` (slide-model
 * tokens.ts) yields a colour for `colors.*` and — transitively through the
 * style's own colour — for `textStyles.*`; an `effectStyles.*` ref in a
 * colour slot resolves to `null` and paints transparent, so it is rejected.
 */
const COLOR_TOKEN_REF_PATTERN = /^(colors|textStyles)\.[A-Za-z0-9_-]+$/

/** `{ $token: "<category>.<id>" }` — any token category. */
export const TokenRefSchema = z.strictObject({
  $token: z.string().regex(TOKEN_REF_PATTERN, {
    message: 'Expected "<colors|textStyles|effectStyles>.<id>"',
  }),
})

/** A token ref that resolves to a colour — the only kind a colour slot may hold. */
export const ColorTokenRefSchema = z.strictObject({
  $token: z.string().regex(COLOR_TOKEN_REF_PATTERN, {
    message: 'Expected a colour token "<colors|textStyles>.<id>"',
  }),
})

/** Stored form of every `number | TokenRef` colour field. */
export const ColorValueSchema = z.union([ColorIntSchema, ColorTokenRefSchema])

/**
 * Parse `#RGB` / `#RRGGBB` into `0xRRGGBB`. Only called after the regex
 * below has matched, so the string is known-good.
 */
function hexToColorInt(hex: string): number {
  const digits = hex.slice(1)
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits
  return Number.parseInt(full, 16)
}

/**
 * `'#RRGGBB'` or `'#RGB'` (case-insensitive) → `0xRRGGBB`. A pipe from a
 * validated string into a transform, so the JSON Schema of the *input*
 * side (what a model sees) is a plain pattern-constrained string.
 */
export const HexColorStringSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, { message: 'Expected "#RRGGBB" or "#RGB"' })
  .transform(hexToColorInt)

/**
 * Agent-facing colour for fields that store a bare `number` (gradient
 * stops, slide backgrounds): an `0xRRGGBB` int or a hex string. Output is
 * always the stored integer form.
 */
export const RgbInputSchema = z.union([ColorIntSchema, HexColorStringSchema])

/**
 * Agent-facing colour for `number | TokenRef` fields: an `0xRRGGBB` int, a
 * `'#RRGGBB'` / `'#RGB'` string, or a colour token ref. Output is exactly
 * the stored shape (`number | TokenRef`), so a parsed value can be written
 * to the Y.Doc without further conversion.
 */
export const ColorInputSchema = z.union([ColorIntSchema, HexColorStringSchema, ColorTokenRefSchema])

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** `{ x, y }` offset — line endpoints, bezier handles. */
export const PointSchema = z.strictObject({ x: FiniteNumberSchema, y: FiniteNumberSchema })
