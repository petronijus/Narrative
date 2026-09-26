import { describe, expect, it } from 'vitest'
import type { SlideObjectType } from '../slide.js'
import { VALID_OBJECTS } from './fixtures.js'
import { objectCreateInputSchema, objectPatchInputSchema } from './input.js'

const TYPES = Object.keys(VALID_OBJECTS) as SlideObjectType[]

describe('objectPatchInputSchema', () => {
  it.each(TYPES)('%s: a full valid object minus id/type is a valid patch', (type) => {
    const { id: _id, type: _type, ...rest } = VALID_OBJECTS[type]
    expect(objectPatchInputSchema(type).parse(rest)).toEqual(rest)
  })

  it('accepts an empty patch', () => {
    expect(objectPatchInputSchema('rectangle').parse({})).toEqual({})
  })

  it('rejects unknown keys — the guard updateObject itself lacks', () => {
    const r = objectPatchInputSchema('rectangle').safeParse({ x: 10, fontSize: 12 })
    expect(r.success).toBe(false)
    expect(r.error?.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['fontSize'], path: [] }),
    ])
  })

  it('rejects id and type (immutable)', () => {
    const r = objectPatchInputSchema('text').safeParse({ id: 'x', type: 'rectangle' })
    expect(r.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['id', 'type'] })
  })

  it('normalises hex colours in every colour slot, nested ones included', () => {
    const out = objectPatchInputSchema('rectangle').parse({
      fill: '#336699',
      stroke: '#fff',
      shadow: { color: '#000', blur: 4, offsetX: 0, offsetY: 2, opacity: 0.5 },
      fillStyle: {
        kind: 'linearGradient',
        angleDeg: 0,
        stops: [
          { color: '#ff0000', offset: 0 },
          { color: 0x00ff00, offset: 1 },
        ],
      },
    })
    expect(out).toEqual({
      fill: 0x336699,
      stroke: 0xffffff,
      shadow: { color: 0x000000, blur: 4, offsetX: 0, offsetY: 2, opacity: 0.5 },
      fillStyle: {
        kind: 'linearGradient',
        angleDeg: 0,
        stops: [
          { color: 0xff0000, offset: 0 },
          { color: 0x00ff00, offset: 1 },
        ],
      },
    })
  })

  it('normalises table cell and border colours', () => {
    const out = objectPatchInputSchema('table').parse({
      defaults: {
        ...VALID_OBJECTS.table.defaults,
        color: '#123',
        border: { color: '#abc', width: 1 },
      },
    })
    expect(out.defaults?.color).toBe(0x112233)
    expect(out.defaults?.border?.color).toBe(0xaabbcc)
  })

  it('maps null on an optional field to undefined (= delete the key)', () => {
    const out = objectPatchInputSchema('rectangle').parse({ stroke: null, cornerRadius: null })
    expect(out).toEqual({ stroke: undefined, cornerRadius: undefined })
    // The key must be PRESENT with undefined — updateObject iterates
    // Object.entries and deletes on undefined; an absent key is a no-op.
    expect(Object.keys(out).sort()).toEqual(['cornerRadius', 'stroke'])
  })

  it('refuses to clear a required field', () => {
    const schema = objectPatchInputSchema('rectangle')
    expect(schema.safeParse({ fill: null }).error?.issues[0]?.path).toEqual(['fill'])
    expect(schema.safeParse({ fill: undefined }).success).toBe(false)
    expect(objectPatchInputSchema('text').safeParse({ text: null }).success).toBe(false)
  })

  it('takes a plain string as the text body', () => {
    expect(objectPatchInputSchema('text').parse({ text: 'New copy' })).toEqual({ text: 'New copy' })
    expect(objectPatchInputSchema('text').safeParse({ text: 42 }).success).toBe(false)
  })

  it('keeps value constraints', () => {
    const r = objectPatchInputSchema('text').safeParse({ colorAlpha: 3, fontSize: -1 })
    expect(r.error?.issues.map((i) => i.path)).toEqual([['fontSize'], ['colorAlpha']])
  })

  it('sanitises hyperlinks and rejects unsafe ones', () => {
    const schema = objectPatchInputSchema('image')
    expect(schema.parse({ hyperlink: { kind: 'url', href: 'mailto:hi@example.com' } })).toEqual({
      hyperlink: { kind: 'url', href: 'mailto:hi@example.com' },
    })
    const bad = schema.safeParse({ hyperlink: { kind: 'url', href: 'javascript:void(0)' } })
    expect(bad.error?.issues[0]?.path).toEqual(['hyperlink', 'href'])
    expect(schema.parse({ hyperlink: null })).toEqual({ hyperlink: undefined })
  })
})

describe('objectCreateInputSchema', () => {
  it.each(TYPES)('%s: a full valid object minus id/type is valid overrides', (type) => {
    const { id: _id, type: _type, ...rest } = VALID_OBJECTS[type]
    expect(objectCreateInputSchema(type).parse(rest)).toEqual(rest)
  })

  it('accepts no overrides at all (registry defaults fill everything)', () => {
    expect(objectCreateInputSchema('image').parse({})).toEqual({})
  })

  it('normalises hex colours', () => {
    expect(objectCreateInputSchema('text').parse({ color: '#0af', text: 'Hi' })).toEqual({
      color: 0x00aaff,
      text: 'Hi',
    })
  })

  it('rejects null, id, type and unknown keys', () => {
    const schema = objectCreateInputSchema('ellipse')
    expect(schema.safeParse({ stroke: null }).success).toBe(false)
    expect(schema.safeParse({ id: 'mine' }).success).toBe(false)
    expect(schema.safeParse({ type: 'ellipse' }).success).toBe(false)
    expect(schema.safeParse({ sides: 5 }).success).toBe(false)
  })
})
