/**
 * shared/src/schema/plain.ts
 *
 * The plain-data view of the slide-object types — what a schema can parse.
 *
 * `TextObject.text` and `TableCell.text` are typed `string | Y.Text`
 * because a live Y.Doc holds a collaborative `Y.Text` there. A schema
 * validates JSON-shaped data coming from an agent, a file or the wire,
 * where a `Y.Text` can never appear: the slide model promotes a plain
 * string into a `Y.Text` on write (`createTextValue` in `addObject` /
 * `updateObject`). So every schema models the text body as `string`, and
 * the compile-time coverage check (./coverage.typecheck.ts) compares the
 * schemas against these mapped types instead of the raw interfaces.
 *
 * The mapped types are homomorphic (`[K in keyof T]`), which keeps each
 * property's optional modifier and exact type untouched — only the text
 * body changes. That is what keeps the coverage check honest: adding a
 * property to `TextObject` adds it here too, and the schema must follow.
 */

import type { SlideObject, SlideObjectType, TableCell, TableObject, TextObject } from '../slide.js'

/** {@link TextObject} with its body as a plain string. */
export type PlainTextObject = { [K in keyof TextObject]: K extends 'text' ? string : TextObject[K] }

/** {@link TableCell} with its body as a plain string. */
export type PlainTableCell = { [K in keyof TableCell]: K extends 'text' ? string : TableCell[K] }

/** {@link TableObject} whose cells carry plain-string bodies. */
export type PlainTableObject = {
  [K in keyof TableObject]: K extends 'rows' ? PlainTableCell[][] : TableObject[K]
}

/** {@link SlideObject} with every text body as a plain string. */
export type PlainSlideObject =
  Exclude<SlideObject, TextObject | TableObject> | PlainTextObject | PlainTableObject

/** The {@link PlainSlideObject} variant for one `type`. */
export type PlainSlideObjectOf<T extends SlideObjectType> = Extract<PlainSlideObject, { type: T }>

/** Keys whose absence is legal in `T` (optional properties). */
type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

/**
 * What an object patch parses to. Every key is optional (a patch touches
 * only what it names); keys that are OPTIONAL in the stored type may also
 * carry `undefined`, which the slide model's `updateObject` turns into
 * "delete this key". Keys that are required in the stored type cannot be
 * `undefined` — deleting them would leave an object the renderer cannot
 * draw. `id` and `type` are immutable and never part of a patch.
 *
 * Note this is wider than `SlideObjectPatch<T>` (`Partial<Omit<…>>`), which
 * under `exactOptionalPropertyTypes` cannot express the `undefined` delete
 * marker that `updateObject` already honours at runtime.
 */
export type ObjectPatch<T> = {
  [K in keyof T as K extends 'id' | 'type' ? never : K]+?: K extends OptionalKeys<T>
    ? T[K] | undefined
    : T[K]
}

/**
 * What creation overrides parse to: any subset of the stored fields except
 * `id` / `type` (the slide model generates the id and the caller names the
 * type). Values are exact — there is nothing to delete on a new object.
 */
export type ObjectCreateOverrides<T> = {
  [K in keyof T as K extends 'id' | 'type' ? never : K]+?: T[K]
}
