/**
 * mcp/schemaCompact.ts — make a tool's generated input schema smaller
 * without making it say less. Every MCP session loads the whole tool list
 * into the model's context (≈ 235 KB of JSON before this existed), so bytes
 * here are paid on every turn of every session.
 *
 * Seven passes, all pure and per tool (every tool's schema stays
 * self-contained: `$defs` never cross tools):
 *
 *   0. Bounds that tell a model nothing are dropped: `minLength: 1` (197
 *      times — "not empty"), zod's safe-integer `maximum`/`minimum` on every
 *      `.int()` (±9007199254740991), and `maxLength` caps of 64 and more
 *      (ids 64, titles 200, URLs 2048, text 100000, base64 64 MiB) — those
 *      are storage and abuse limits no real call comes near, not guidance.
 *      The server still enforces all of them and names the violation.
 *      Short caps (< 64, e.g. a 2-letter code) shape valid values and stay.
 *   1. Discriminated unions collapse into one object. zod renders a union of
 *      object types (`object.create`'s `object`: rectangle | text | image |
 *      …, 11 branches) as `oneOf` with the shared properties repeated in
 *      every branch. When every branch is an object with a common string
 *      discriminator (`type: 'rectangle'`), the union becomes ONE object:
 *      the discriminator an `enum`, every property once, and one line in
 *      the description saying which properties belong to which branch. The
 *      schema is then looser than the command (it accepts a text property
 *      on a rectangle); the server still validates every call against the
 *      real zod union and names the offending key, so nothing is lost but
 *      bytes. Unions without a discriminator are left alone.
 *   2. Cheap `$defs` are inlined. zod's `reused: 'ref'` hoists every schema
 *      used twice — including `{"type":"number"}`, 18 bytes, behind a
 *      28-byte `{"$ref":"#/$defs/__schema3"}` — which costs bytes and makes
 *      the model chase opaque names. A definition is inlined when that is
 *      no larger than keeping it (used once, or small); what is still
 *      shared and large stays a `$ref`. Recursive definitions always stay.
 *   3. Only the root says `additionalProperties: false`. Nested objects list
 *      their properties, which is what a model goes by; repeating the
 *      closedness on every nested shape cost ≈ 5 KB. The server validates
 *      strictly at every level and names an unknown key in its error.
 *   4. Identical alternatives of a union are said once. Merging the kinds
 *      of a discriminated union (pass 1), inlining (pass 2) and dropping
 *      nested closedness (pass 3) can leave `anyOf: [X, X]` — on
 *      `object.create` the stroke and alpha fields were the same schema per
 *      kind. Duplicates are dropped; a union left with one alternative
 *      becomes that alternative (its siblings, e.g. a description, kept).
 *   5. A nullable field is one schema. zod renders `.nullable()` (a field
 *      `null` clears: token_update, the table styles,
 *      text_setBoxTypography — 57 fields) as `anyOf: [X, { type: 'null' }]`;
 *      when X is a plain typed schema it becomes X with `type: [t, 'null']`
 *      (and `null` added to an `enum`), the same set of valid values in
 *      about 18 fewer bytes.
 *   6. A union of string constants is one enum. A discriminated union's
 *      tag read on its own (`category: 'colors' | 'textStyles'`, an `op`)
 *      renders as `anyOf` of `const` branches; it becomes
 *      `{ type: 'string', enum: [...] }`, duplicates said once.
 */

type JsonSchema = Record<string, unknown>

/** A union needs at least this many branches before collapsing pays off (and reads well). */
const MIN_COLLAPSE_BRANCHES = 3
/** What one `$ref` costs, with a typical definition name. */
const REF_COST = JSON.stringify({ $ref: '#/$defs/__schema00' }).length

function isObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function defsOf(root: JsonSchema): Record<string, JsonSchema> {
  return isObject(root['$defs']) ? (root['$defs'] as Record<string, JsonSchema>) : {}
}

function refName(node: JsonSchema): string | null {
  const ref = node['$ref']
  if (typeof ref !== 'string') return null
  const m = /^#\/\$defs\/(.+)$/.exec(ref)
  return m === null ? null : decodeURIComponent(m[1]!)
}

/** A `$ref` node's definition (siblings such as `description` win over it); other nodes as they are. */
function resolve(node: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  const name = refName(node)
  const target = name === null ? undefined : defs[name]
  if (target === undefined) return node
  const { $ref: _ref, ...siblings } = node
  return { ...target, ...siblings }
}

/** Rebuild every nested schema with `fn` applied bottom-up. */
function mapSchema(value: unknown, fn: (node: JsonSchema) => JsonSchema): unknown {
  if (Array.isArray(value)) return value.map((v) => mapSchema(v, fn))
  if (!isObject(value)) return value
  const mapped: JsonSchema = {}
  for (const [k, v] of Object.entries(value)) mapped[k] = mapSchema(v, fn)
  return fn(mapped)
}

// ---------------------------------------------------------------------------
// 0. Bounds without information
// ---------------------------------------------------------------------------

/** `maxLength` at or above this is a storage / abuse cap, not usage guidance. */
export const CAP_MAX_LENGTH = 64

function dropUninformativeBounds(node: JsonSchema): JsonSchema {
  const out = { ...node }
  if (out['minLength'] === 1) delete out['minLength']
  if (typeof out['maxLength'] === 'number' && out['maxLength'] >= CAP_MAX_LENGTH)
    delete out['maxLength']
  if (out['maximum'] === Number.MAX_SAFE_INTEGER) delete out['maximum']
  if (out['minimum'] === Number.MIN_SAFE_INTEGER) delete out['minimum']
  return out
}

// ---------------------------------------------------------------------------
// 1. Discriminated unions
// ---------------------------------------------------------------------------

function constOf(schema: unknown): unknown {
  if (!isObject(schema)) return undefined
  if ('const' in schema) return schema['const']
  const values = schema['enum']
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined
}

function propertiesOf(branch: JsonSchema): Record<string, JsonSchema> {
  return isObject(branch['properties']) ? (branch['properties'] as Record<string, JsonSchema>) : {}
}

/** The property every branch fixes to a distinct string, if there is one. */
function discriminatorOf(branches: JsonSchema[]): string | null {
  for (const key of Object.keys(propertiesOf(branches[0]!))) {
    const values = branches.map((b) => constOf(propertiesOf(b)[key]))
    if (values.every((v) => typeof v === 'string') && new Set(values).size === values.length)
      return key
  }
  return null
}

function collapseUnion(node: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  const key = Array.isArray(node['oneOf']) ? 'oneOf' : Array.isArray(node['anyOf']) ? 'anyOf' : null
  if (key === null) return node
  const raw = node[key] as unknown[]
  if (raw.length < MIN_COLLAPSE_BRANCHES || !raw.every(isObject)) return node
  const branches = (raw as JsonSchema[]).map((b) => resolve(b, defs))
  if (!branches.every((b) => b['type'] === 'object' && isObject(b['properties']))) return node
  const discriminator = discriminatorOf(branches)
  if (discriminator === null) return node

  const tags = branches.map((b) => constOf(propertiesOf(b)[discriminator]) as string)
  const requiredIn = branches.map((b) => new Set((b['required'] ?? []) as string[]))
  const variants = new Map<string, JsonSchema[]>()
  const branchesOf = new Map<string, number[]>()
  branches.forEach((branch, i) => {
    for (const [prop, schema] of Object.entries(propertiesOf(branch))) {
      if (prop === discriminator) continue
      const list = variants.get(prop) ?? []
      const json = JSON.stringify(schema)
      if (!list.some((s) => JSON.stringify(s) === json)) list.push(schema)
      variants.set(prop, list)
      branchesOf.set(prop, [...(branchesOf.get(prop) ?? []), i])
    }
  })

  const properties: Record<string, JsonSchema> = {}
  const tagSchema = propertiesOf(branches[0]!)[discriminator]!
  properties[discriminator] = {
    type: 'string',
    enum: tags,
    ...(typeof tagSchema['description'] === 'string'
      ? { description: tagSchema['description'] }
      : {}),
  }
  for (const [prop, list] of variants)
    properties[prop] = list.length === 1 ? list[0]! : { anyOf: list }

  const all = branches.map((_, i) => i)
  const kindsOf = (prop: string): number[] => branchesOf.get(prop) ?? []
  const required = [
    discriminator,
    ...[...variants.keys()].filter((p) => all.every((i) => requiredIn[i]!.has(p))),
  ]
  // A property required in only some branches: say where.
  const label = (prop: string): string => {
    if (required.includes(prop)) return prop
    const where = kindsOf(prop).filter((i) => requiredIn[i]!.has(prop))
    if (where.length === 0) return prop
    return where.length === kindsOf(prop).length
      ? `${prop} (required)`
      : `${prop} (required for ${where.map((i) => tags[i]).join(', ')})`
  }
  // Properties grouped by exactly which kinds take them: "fill, fillAlpha:
  // rectangle, ellipse, path" says once what per-kind lists would repeat.
  const groups = new Map<string, string[]>()
  for (const prop of variants.keys()) {
    const kinds = kindsOf(prop)
    const key = kinds.length === branches.length ? '*' : kinds.map((i) => tags[i]).join(', ')
    groups.set(key, [...(groups.get(key) ?? []), label(prop)])
  }
  const everyKind = groups.get('*')
  const partial = [...groups.entries()].filter(([k]) => k !== '*')
  const differing = [...variants.entries()].filter(([, list]) => list.length > 1).map(([p]) => p)
  const description = [
    typeof node['description'] === 'string' ? node['description'] : null,
    `One of ${tags.length} kinds, chosen by \`${discriminator}\`.`,
    everyKind !== undefined ? `Every kind takes ${everyKind.join(', ')}.` : null,
    partial.length > 0
      ? `Only some kinds take — ${partial.map(([kinds, props]) => `${props.join(', ')}: ${kinds}`).join('; ')}.`
      : null,
    differing.length > 0 ? `${differing.join(', ')}: shape differs by kind (see anyOf).` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' ')

  const { [key]: _branches, description: _d, ...rest } = node
  return {
    ...rest,
    type: 'object',
    description,
    properties,
    required,
    ...(branches.every((b) => b['additionalProperties'] === false)
      ? { additionalProperties: false }
      : {}),
  }
}

/**
 * `{ id } | { index }`-style alternatives: two or more branches of a union
 * that are each a closed object with exactly one required property become
 * ONE closed object holding all those properties with `minProperties` and
 * `maxProperties` 1 — the same set of valid values, said once (the slide
 * reference, on 45 tools, drops from 335 to about 230 bytes).
 */
function mergeSingleKeyBranches(node: JsonSchema): JsonSchema {
  const key = Array.isArray(node['anyOf']) ? 'anyOf' : Array.isArray(node['oneOf']) ? 'oneOf' : null
  if (key === null) return node
  const branches = node[key] as unknown[]
  const isWrapper = (b: unknown): b is JsonSchema => {
    if (!isObject(b) || b['type'] !== 'object' || b['additionalProperties'] !== false) return false
    const props = Object.keys(propertiesOf(b))
    const required = (b['required'] ?? []) as unknown[]
    const extra = Object.keys(b).filter(
      (k) => !['type', 'properties', 'required', 'additionalProperties'].includes(k),
    )
    return (
      props.length === 1 && required.length === 1 && required[0] === props[0] && extra.length === 0
    )
  }
  const wrappers = branches.filter(isWrapper)
  const names = wrappers.map((w) => Object.keys(propertiesOf(w))[0]!)
  if (wrappers.length < 2 || new Set(names).size !== names.length) return node
  const merged: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(wrappers.map((w) => Object.entries(propertiesOf(w))[0]!)),
    minProperties: 1,
    maxProperties: 1,
    additionalProperties: false,
  }
  const rest = branches.filter((b) => !isWrapper(b))
  const { [key]: _all, ...siblings } = node
  return rest.length === 0 ? { ...siblings, ...merged } : { ...siblings, [key]: [...rest, merged] }
}

// ---------------------------------------------------------------------------
// 2. Cheap definitions inline
// ---------------------------------------------------------------------------

function countRefs(value: unknown, into: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const v of value) countRefs(v, into)
    return
  }
  if (!isObject(value)) return
  const name = refName(value)
  if (name !== null) into.set(name, (into.get(name) ?? 0) + 1)
  for (const v of Object.values(value)) countRefs(v, into)
}

function refersTo(value: unknown, name: string): boolean {
  const refs = new Map<string, number>()
  countRefs(value, refs)
  return refs.has(name)
}

function replaceRefs(value: unknown, name: string, definition: JsonSchema): unknown {
  if (Array.isArray(value)) return value.map((v) => replaceRefs(v, name, definition))
  if (!isObject(value)) return value
  if (refName(value) === name) {
    const { $ref: _ref, ...siblings } = value
    return { ...structuredClone(definition), ...siblings }
  }
  const out: JsonSchema = {}
  for (const [k, v] of Object.entries(value)) out[k] = replaceRefs(v, name, definition)
  return out
}

/**
 * Drop definitions nothing refers to any more and inline the ones that became
 * cheap (sharedShapes.ts calls it after replacing subtrees that used them).
 */
export function inlineCheapDefinitions(root: JsonSchema): JsonSchema {
  let schema = root
  for (;;) {
    const defs = defsOf(schema)
    const names = Object.keys(defs)
    if (names.length === 0) break
    const uses = new Map<string, number>()
    countRefs(schema, uses)
    const unused = names.filter((n) => !uses.has(n))
    const cheap = names.find((n) => {
      const count = uses.get(n) ?? 0
      if (count === 0 || refersTo(defs[n], n)) return false
      const size = JSON.stringify(defs[n]).length
      // Keeping it costs the definition plus a $ref per use; inlining, a copy per use.
      return count * size <= size + n.length + 4 + count * REF_COST
    })
    if (unused.length === 0 && cheap === undefined) break
    const nextDefs = { ...defs }
    for (const n of unused) delete nextDefs[n]
    let next: JsonSchema = { ...schema, $defs: nextDefs }
    if (cheap !== undefined) {
      const definition = nextDefs[cheap]!
      delete nextDefs[cheap]
      next = replaceRefs({ ...next, $defs: nextDefs }, cheap, definition) as JsonSchema
    }
    schema = next
  }
  if (Object.keys(defsOf(schema)).length === 0) {
    const { $defs: _defs, ...rest } = schema
    return rest
  }
  return schema
}

function dropNestedClosedness(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((v) => dropNestedClosedness(v, depth + 1))
  if (!isObject(value)) return value
  const out: JsonSchema = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'additionalProperties' && v === false && depth > 0) continue
    out[k] = dropNestedClosedness(v, depth + 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. Identical union alternatives
// ---------------------------------------------------------------------------

function dedupeUnionAlternatives(node: JsonSchema): JsonSchema {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = node[key]
    if (!Array.isArray(branches)) continue
    const seen = new Set<string>()
    const distinct = branches.filter((b) => {
      const json = JSON.stringify(b)
      if (seen.has(json)) return false
      seen.add(json)
      return true
    })
    if (distinct.length === branches.length) continue
    const { [key]: _all, ...siblings } = node
    if (distinct.length === 1 && isObject(distinct[0])) return { ...distinct[0], ...siblings }
    return { ...siblings, [key]: distinct }
  }
  return node
}

// ---------------------------------------------------------------------------
// 5. Nullable fields
// ---------------------------------------------------------------------------

const NULL_TYPE = JSON.stringify({ type: 'null' })

function mergeNullable(node: JsonSchema): JsonSchema {
  const branches = node['anyOf']
  if (!Array.isArray(branches) || branches.length !== 2) return node
  const nullAt = branches.findIndex((b) => JSON.stringify(b) === NULL_TYPE)
  if (nullAt === -1) return node
  const other = branches[1 - nullAt]
  // Only a plain typed schema: a $ref, a union or a const has no `type` to widen.
  if (
    !isObject(other) ||
    typeof other['type'] !== 'string' ||
    ['$ref', 'anyOf', 'oneOf', 'allOf', 'const'].some((k) => k in other)
  )
    return node
  const { anyOf: _anyOf, ...siblings } = node
  const enumValues = other['enum']
  return {
    ...other,
    ...siblings,
    type: [other['type'], 'null'],
    ...(Array.isArray(enumValues) ? { enum: [...enumValues, null] } : {}),
  }
}

// ---------------------------------------------------------------------------
// 6. String constants
// ---------------------------------------------------------------------------

function mergeStringConstants(node: JsonSchema): JsonSchema {
  const key = Array.isArray(node['anyOf']) ? 'anyOf' : Array.isArray(node['oneOf']) ? 'oneOf' : null
  if (key === null) return node
  const branches = node[key] as unknown[]
  // Only bare constants: a branch's own description would be lost.
  const bare = (b: unknown): b is JsonSchema =>
    isObject(b) &&
    b['type'] === 'string' &&
    ('const' in b || Array.isArray(b['enum'])) &&
    Object.keys(b).every((k) => k === 'type' || k === 'const' || k === 'enum')
  if (branches.length < 2 || !branches.every(bare)) return node
  const values = branches.flatMap((b) => ('const' in b ? [b['const']] : (b['enum'] as unknown[])))
  const { [key]: _all, ...siblings } = node
  return { ...siblings, type: 'string', enum: [...new Set(values)] }
}

/** The passes, in order. Returns a new schema; `root` is not modified. */
export function compactInputSchema(input: JsonSchema): JsonSchema {
  const root = mapSchema(input, dropUninformativeBounds) as JsonSchema
  // Definitions first, so a union whose branches are `$ref`s sees them
  // already collapsed inside; then everything else against those.
  const original = defsOf(root)
  const defs: Record<string, JsonSchema> = {}
  for (const [name, def] of Object.entries(original))
    defs[name] = mapSchema(def, (node) => collapseUnion(node, original)) as JsonSchema
  const { $defs: _defs, ...body } = root
  const collapsed = mapSchema(body, (node) =>
    mergeSingleKeyBranches(collapseUnion(node, defs)),
  ) as JsonSchema
  for (const [name, def] of Object.entries(defs))
    defs[name] = mapSchema(def, mergeSingleKeyBranches) as JsonSchema
  const inlined = inlineCheapDefinitions(
    Object.keys(defs).length > 0 ? { ...collapsed, $defs: defs } : collapsed,
  )
  return mapSchema(dropNestedClosedness(inlined, 0), (node) =>
    mergeStringConstants(mergeNullable(dedupeUnionAlternatives(node))),
  ) as JsonSchema
}
