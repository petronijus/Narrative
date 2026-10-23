/**
 * schemaCompact.ts — each pass on its own, plus the property that matters
 * most: a compacted schema still accepts what the original accepted (the
 * compaction may loosen a schema, never tighten it; the server validates
 * against the real zod schema anyway). mcp.test.ts checks the same for
 * every command example against the generated tools.
 */

import { describe, expect, it } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { compactInputSchema } from './schemaCompact.js'

const ajv = new Ajv2020({ strict: false })
const valid = (schema: object, value: unknown): boolean => ajv.validate(schema, value) as boolean

describe('compactInputSchema', () => {
  it('drops bounds that carry no information, keeps short caps', () => {
    const out = compactInputSchema({
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64 },
        code: { type: 'string', maxLength: 2 },
        n: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    })
    expect(out['properties']).toEqual({
      id: { type: 'string' },
      code: { type: 'string', maxLength: 2 },
      n: { type: 'integer', minimum: 0 },
    })
  })

  it('collapses a discriminated union into one object and says which kind takes what', () => {
    const shape = (kind: string, extra: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties: { kind: { type: 'string', const: kind }, x: { type: 'number' }, ...extra },
      required: ['kind', ...required],
      additionalProperties: false,
    })
    const original = {
      type: 'object',
      properties: {
        shape: {
          oneOf: [
            shape('rect', { radius: { type: 'number' } }),
            shape('circle', { r: { type: 'number' } }, ['r']),
            shape('image', { assetId: { type: 'string' } }, ['assetId']),
          ],
        },
      },
      required: ['shape'],
      additionalProperties: false,
    }
    const out = compactInputSchema(original)
    const collapsed = (out['properties'] as Record<string, Record<string, unknown>>)['shape']!
    expect(collapsed).not.toHaveProperty('oneOf')
    expect(collapsed['properties']).toMatchObject({
      kind: { enum: ['rect', 'circle', 'image'] },
      x: { type: 'number' },
      radius: {},
      r: {},
      assetId: {},
    })
    expect(collapsed['required']).toEqual(['kind'])
    expect(collapsed['description']).toMatch(/Every kind takes x\./)
    expect(collapsed['description']).toMatch(/radius: rect/)
    expect(collapsed['description']).toMatch(/r \(required\): circle/)
    // Looser, never tighter.
    for (const value of [
      { shape: { kind: 'rect', x: 1, radius: 2 } },
      { shape: { kind: 'circle', r: 3 } },
      { shape: { kind: 'image', assetId: 'a' } },
    ]) {
      expect(valid(original, value)).toBe(true)
      expect(valid(out, value)).toBe(true)
    }
  })

  it('says a property differs by kind only while its anyOf is still there', () => {
    // `fill` differs only in nested closedness, which pass 3 drops: then pass
    // 4 makes it one schema and the note must not point at a missing anyOf.
    // `size` really differs and keeps its anyOf and its note.
    const point = (closed: boolean) => ({
      type: 'object',
      properties: { x: { type: 'number' } },
      ...(closed ? { additionalProperties: false } : {}),
    })
    const shape = (kind: string, closed: boolean, size: Record<string, unknown>) => ({
      type: 'object',
      properties: { kind: { type: 'string', const: kind }, fill: point(closed), size },
      required: ['kind'],
      additionalProperties: false,
    })
    const out = compactInputSchema({
      type: 'object',
      properties: {
        shape: {
          oneOf: [
            shape('a', true, { type: 'number' }),
            shape('b', false, { type: 'string' }),
            shape('c', true, { type: 'number' }),
          ],
        },
      },
    })
    const collapsed = (out['properties'] as Record<string, Record<string, unknown>>)['shape']!
    const props = collapsed['properties'] as Record<string, Record<string, unknown>>
    expect(props['fill']).not.toHaveProperty('anyOf')
    expect(props['size']).toHaveProperty('anyOf')
    expect(collapsed['description']).toMatch(/size: shape differs by kind \(see anyOf\)\./)
    expect(collapsed['description']).not.toMatch(/fill[^.]*differs/)
    expect(JSON.stringify(out)).not.toContain('x-narrative-differing')
  })

  it('says a long list of what every kind takes by what the kind sentence does not name', () => {
    const common = Object.fromEntries(
      ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'name', 'locked', 'shadow'].map((p) => [
        p,
        { type: 'number' },
      ]),
    )
    const shape = (kind: string, extra: Record<string, unknown>) => ({
      type: 'object',
      properties: { kind: { type: 'string', const: kind }, ...common, ...extra },
      required: ['kind'],
    })
    const out = compactInputSchema({
      type: 'object',
      properties: {
        shape: {
          oneOf: [
            shape('rect', { radius: { type: 'number' } }),
            shape('circle', {}),
            shape('image', { assetId: { type: 'string' } }),
          ],
        },
      },
    })
    const collapsed = (out['properties'] as Record<string, Record<string, unknown>>)['shape']!
    expect(collapsed['description']).toBe(
      'One of 3 kinds, chosen by `kind`. Every kind takes the properties not named below. ' +
        'Only some kinds take — radius: rect; assetId: image.',
    )
    expect(Object.keys(collapsed['properties'] as object)).toEqual(
      expect.arrayContaining(Object.keys(common)),
    )
  })

  it('leaves unions without a discriminator alone', () => {
    const union = {
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
        { type: 'object', properties: { c: { type: 'string' } } },
      ],
    }
    const out = compactInputSchema({ type: 'object', properties: { u: union } })
    expect((out['properties'] as Record<string, unknown>)['u']).toEqual(union)
  })

  it('merges closed single-key alternatives into one object with exactly one key', () => {
    const ref = {
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { index: { type: 'integer', minimum: 0 } },
          required: ['index'],
          additionalProperties: false,
        },
      ],
      description: 'Slide id, or { id }, or { index }',
    }
    const original = { type: 'object', properties: { slide: ref } }
    const out = compactInputSchema(original)
    expect((out['properties'] as Record<string, unknown>)['slide']).toEqual({
      description: 'Slide id, or { id }, or { index }',
      anyOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { id: { type: 'string' }, index: { type: 'integer', minimum: 0 } },
          minProperties: 1,
          maxProperties: 1,
        },
      ],
    })
    for (const slide of ['s1', { id: 's1' }, { index: 2 }]) expect(valid(out, { slide })).toBe(true)
    expect(valid(out, { slide: { id: 's1', index: 2 } })).toBe(false)
  })

  it('inlines definitions that are cheaper inline, keeps shared large and recursive ones', () => {
    const large = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `p${i}`,
          { type: 'string', description: `field ${i}` },
        ]),
      ),
    }
    const out = compactInputSchema({
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/num' },
        b: { $ref: '#/$defs/num' },
        c: { $ref: '#/$defs/big' },
        d: { $ref: '#/$defs/big' },
        e: { $ref: '#/$defs/tree' },
      },
      $defs: {
        num: { type: 'number' },
        big: large,
        tree: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/tree' } } },
        },
        unused: { type: 'string' },
      },
    })
    const props = out['properties'] as Record<string, unknown>
    expect(props['a']).toEqual({ type: 'number' })
    expect(props['c']).toEqual({ $ref: '#/$defs/big' })
    expect(props['e']).toEqual({ $ref: '#/$defs/tree' })
    expect(Object.keys(out['$defs'] as object).sort()).toEqual(['big', 'tree'])
  })

  it('says identical union alternatives once, and unwraps a union left with one', () => {
    const colour = { type: 'string', pattern: '^#[0-9a-f]{6}$' }
    const out = compactInputSchema({
      type: 'object',
      properties: {
        stroke: { anyOf: [colour, { ...colour }], description: 'Outline colour' },
        width: { anyOf: [{ type: 'number' }, { type: 'number' }, { type: 'string' }] },
      },
    })
    const props = out['properties'] as Record<string, object>
    expect(props['stroke']).toEqual({ ...colour, description: 'Outline colour' })
    expect(props['width']).toEqual({ anyOf: [{ type: 'number' }, { type: 'string' }] })
    expect(valid(out, { stroke: '#aabbcc', width: 'x' })).toBe(true)
  })

  it('keeps additionalProperties: false only at the root', () => {
    const out = compactInputSchema({
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { x: { type: 'number' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    })
    expect(out['additionalProperties']).toBe(false)
    expect((out['properties'] as Record<string, object>)['inner']).not.toHaveProperty(
      'additionalProperties',
    )
  })

  it('writes a nullable field as one schema with a null type, accepting the same values', () => {
    const original = {
      type: 'object',
      properties: {
        size: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }] },
        align: {
          anyOf: [{ type: 'string', enum: ['left', 'right'] }, { type: 'null' }],
          description: 'null clears it',
        },
        colour: { anyOf: [{ $ref: '#/$defs/c' }, { type: 'null' }] },
      },
      $defs: { c: { type: 'string', pattern: '^#', description: 'a colour, used twice' } },
    }
    const out = compactInputSchema(original)
    const props = out['properties'] as Record<string, Record<string, unknown>>
    expect(props['size']).toEqual({ type: ['number', 'null'], exclusiveMinimum: 0 })
    expect(props['align']).toEqual({
      type: ['string', 'null'],
      enum: ['left', 'right', null],
      description: 'null clears it',
    })
    for (const value of [{ size: null }, { size: 3 }, { align: null }, { align: 'left' }])
      expect(valid(out, value), JSON.stringify(value)).toBe(true)
    expect(valid(out, { size: 0 })).toBe(false)
    expect(valid(out, { align: 'up' })).toBe(false)
  })

  it('says a union of string constants as one enum', () => {
    const out = compactInputSchema({
      type: 'object',
      properties: {
        category: {
          anyOf: [
            { type: 'string', const: 'colors' },
            { type: 'string', const: 'textStyles' },
          ],
        },
        kind: {
          anyOf: [
            { type: 'string', enum: ['bullet', 'none'] },
            { type: 'string', const: 'none' },
          ],
        },
        described: {
          anyOf: [
            { type: 'string', const: 'a', description: 'the first' },
            { type: 'string', const: 'b' },
          ],
        },
      },
    })
    const props = out['properties'] as Record<string, Record<string, unknown>>
    expect(props['category']).toEqual({ type: 'string', enum: ['colors', 'textStyles'] })
    expect(props['kind']).toEqual({ type: 'string', enum: ['bullet', 'none'] })
    expect(props['described']).toHaveProperty('anyOf')
  })
})
