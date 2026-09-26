/**
 * shared/src/schema/input.ts
 *
 * Agent-facing input schemas for object commands: the patch an update
 * accepts and the overrides a create accepts. Both are DERIVED from the
 * colour-input variant of the storage schemas (./objects.ts), so a new
 * property on a storage schema — which the coverage check forces whenever
 * the TS interface grows — appears here with no further edit.
 *
 * Why this exists: slide-model `updateObject` writes whatever keys it is
 * handed into the Y.Map. Passing agent input through
 * `objectPatchInputSchema(type)` first rejects unknown keys (strict) and
 * out-of-range values before anything reaches the doc.
 *
 * What a field-wise schema cannot check: invariants spanning several
 * fields (a table's grid shape, a video's trim window) or spanning the
 * patch and the existing object. Command handlers that touch those fields
 * should re-validate the merged result with `slideObjectSchemaFor(type)`.
 */

import { z } from 'zod'
import type { SlideObjectType } from '../slide.js'
import { inputObjectSchemas } from './objects.js'

type ObjectShape = z.core.$ZodLooseShape

/** Key-set of the colour-input schema of each object type. */
type InputShapeOf<T extends SlideObjectType> = (typeof inputObjectSchemas.byType)[T]['shape']

/**
 * A field that was optional in storage becomes clearable in a patch:
 * `null` (JSON's only way to say "no value") parses to `undefined`, which
 * `updateObject` turns into "delete the key".
 */
type ClearableField<I extends z.ZodType> = z.ZodOptional<
  z.ZodType<z.output<I> | undefined, z.input<I> | null>
>

type PatchShape<S extends ObjectShape> = {
  -readonly [K in keyof S as K extends 'id' | 'type' ? never : K]: S[K] extends z.ZodExactOptional<
    infer I extends z.ZodType
  >
    ? ClearableField<I>
    : S[K] extends z.ZodType
      ? z.ZodExactOptional<S[K]>
      : never
}

type CreateShape<S extends ObjectShape> = {
  -readonly [K in keyof S as K extends 'id' | 'type' ? never : K]: S[K] extends z.ZodExactOptional
    ? S[K]
    : S[K] extends z.ZodType
      ? z.ZodExactOptional<S[K]>
      : never
}

/** Schema type returned by {@link objectPatchInputSchema}. */
export type ObjectPatchInputSchema<T extends SlideObjectType> = z.ZodObject<
  PatchShape<InputShapeOf<T>>,
  z.core.$strict
>

/** Schema type returned by {@link objectCreateInputSchema}. */
export type ObjectCreateInputSchema<T extends SlideObjectType> = z.ZodObject<
  CreateShape<InputShapeOf<T>>,
  z.core.$strict
>

function isExactOptional(field: z.core.SomeType): field is z.ZodExactOptional<z.ZodType> {
  return field instanceof z.ZodExactOptional
}

/**
 * Patch rules, per storage key:
 *   - `id`, `type`       → absent (immutable; strictness rejects them).
 *   - required in storage → optional, exact: may be omitted, may not be
 *                            `null`/`undefined` (deleting it would leave an
 *                            object the renderer cannot draw).
 *   - optional in storage → optional and nullable; `null` → `undefined`.
 */
function buildPatchSchema(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.core.SomeType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    if (key === 'id' || key === 'type') continue
    if (isExactOptional(field)) {
      shape[key] = field
        .unwrap()
        .nullable()
        .transform((v) => (v === null ? undefined : v))
        .optional()
    } else {
      shape[key] = (field as z.ZodType).exactOptional()
    }
  }
  return z.strictObject(shape)
}

/**
 * Create-override rules: every storage key except `id` / `type` becomes
 * optional (the slide-model registry supplies defaults), values are exact
 * — on a new object there is nothing to delete, so `null` is rejected.
 */
function buildCreateSchema(schema: z.ZodObject): z.ZodObject {
  const shape: Record<string, z.core.SomeType> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    if (key === 'id' || key === 'type') continue
    shape[key] = isExactOptional(field) ? field : (field as z.ZodType).exactOptional()
  }
  return z.strictObject(shape)
}

const OBJECT_TYPES = Object.keys(inputObjectSchemas.byType) as SlideObjectType[]

// Built once at module load: 11 small schemas each, and the command layer
// asks for them on every invocation. The casts bridge the runtime builders
// (which walk an untyped shape) to the mapped types above; the coverage
// check pins the resulting OUTPUT types to `ObjectPatch<T>` /
// `ObjectCreateOverrides<T>`, so a builder/type mismatch cannot hide here.
const PATCH_SCHEMAS = Object.fromEntries(
  OBJECT_TYPES.map((t) => [t, buildPatchSchema(inputObjectSchemas.byType[t])]),
) as unknown as { [T in SlideObjectType]: ObjectPatchInputSchema<T> }

const CREATE_SCHEMAS = Object.fromEntries(
  OBJECT_TYPES.map((t) => [t, buildCreateSchema(inputObjectSchemas.byType[t])]),
) as unknown as { [T in SlideObjectType]: ObjectCreateInputSchema<T> }

/**
 * The strict partial an update command accepts for objects of `type`.
 * Colour fields take `ColorInputSchema` (int, `#RRGGBB`, `#RGB`, TokenRef),
 * `text` takes a plain string, and `null` on an optional field means
 * "delete this key" (parsed to `undefined`, which `updateObject` deletes).
 */
export function objectPatchInputSchema<T extends SlideObjectType>(
  type: T,
): ObjectPatchInputSchema<T> {
  return PATCH_SCHEMAS[type]
}

/**
 * The strict overrides a create command accepts for objects of `type`, to
 * be merged over the slide-model registry defaults. Same colour and text
 * handling as the patch; no `null`, no `id`, no `type`.
 */
export function objectCreateInputSchema<T extends SlideObjectType>(
  type: T,
): ObjectCreateInputSchema<T> {
  return CREATE_SCHEMAS[type]
}
