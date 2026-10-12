import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { SlideObjectType } from '../slide.js'
import { VALID_OBJECTS } from './fixtures.js'
import {
  ParagraphAttrsSchema,
  RectangleObjectSchema,
  SlideObjectSchema,
  TableObjectSchema,
  TextObjectSchema,
  VideoObjectSchema,
  slideObjectSchemaFor,
} from './objects.js'

/** Paths of every issue, for compact assertions on where a parse failed. */
function issuePaths(result: { success: boolean; error?: z.ZodError }): PropertyKey[][] {
  return (result.error?.issues ?? []).map((i) => i.path)
}

const TYPES = Object.keys(VALID_OBJECTS) as SlideObjectType[]

describe('storage schemas — valid objects', () => {
  it.each(TYPES)('%s parses through its own schema and the union unchanged', (type) => {
    const obj = VALID_OBJECTS[type]
    expect(slideObjectSchemaFor(type).parse(obj)).toEqual(obj)
    expect(SlideObjectSchema.parse(obj)).toEqual(obj)
  })

  it('covers every object type', () => {
    expect(TYPES.sort()).toEqual(
      [
        'arrow',
        'ellipse',
        'image',
        'line',
        'path',
        'polygon',
        'rectangle',
        'table',
        'text',
        'triangle',
        'video',
      ].sort(),
    )
  })
})

describe('storage schemas — invalid objects', () => {
  const rect = VALID_OBJECTS.rectangle

  it('rejects an unknown object type at the discriminator', () => {
    const r = SlideObjectSchema.safeParse({ ...rect, type: 'componentInstance' })
    expect(r.success).toBe(false)
    expect(issuePaths(r)).toEqual([['type']])
  })

  it('rejects alpha / opacity outside [0, 1] with the field path', () => {
    const r = RectangleObjectSchema.safeParse({
      ...rect,
      fillAlpha: 1.5,
      opacity: -0.1,
      shadow: { ...rect.shadow, opacity: 2 },
    })
    expect(issuePaths(r)).toEqual(
      expect.arrayContaining([['fillAlpha'], ['opacity'], ['shadow', 'opacity']]),
    )
  })

  it('rejects non-finite geometry and negative sizes', () => {
    const r = RectangleObjectSchema.safeParse({
      ...rect,
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: -1,
    })
    expect(issuePaths(r)).toEqual(expect.arrayContaining([['x'], ['y'], ['width']]))
  })

  it('rejects unknown keys (strict), at the top level and nested', () => {
    const top = RectangleObjectSchema.safeParse({ ...rect, bogus: 1 })
    expect(top.success).toBe(false)
    expect(top.error?.issues[0]?.code).toBe('unrecognized_keys')

    const nested = RectangleObjectSchema.safeParse({
      ...rect,
      shadow: { ...rect.shadow, spread: 2 },
    })
    expect(issuePaths(nested)).toEqual([['shadow']])
  })

  it('rejects an explicit undefined on an optional key (exact optional)', () => {
    expect(RectangleObjectSchema.safeParse({ ...rect, stroke: undefined }).success).toBe(false)
  })

  it('rejects a missing required key', () => {
    const { fill: _fill, ...noFill } = rect
    expect(issuePaths(RectangleObjectSchema.safeParse(noFill))).toEqual([['fill']])
  })

  it('enforces the gradient stop count and offsets', () => {
    const grad = rect.fillStyle
    if (grad?.kind !== 'linearGradient') throw new Error('fixture changed')
    const oneStop = RectangleObjectSchema.safeParse({
      ...rect,
      fillStyle: { ...grad, stops: [grad.stops[0]] },
    })
    expect(issuePaths(oneStop)).toEqual([['fillStyle', 'stops']])

    const elevenStops = Array.from({ length: 11 }, (_, i) => ({ color: 0, offset: i / 10 }))
    expect(
      RectangleObjectSchema.safeParse({ ...rect, fillStyle: { ...grad, stops: elevenStops } })
        .success,
    ).toBe(false)

    const badOffset = RectangleObjectSchema.safeParse({
      ...rect,
      fillStyle: { ...grad, stops: [grad.stops[0], { color: 0, offset: 1.2 }] },
    })
    expect(issuePaths(badOffset)).toEqual([['fillStyle', 'stops', 1, 'offset']])
  })

  it('rejects colour ints outside 24 bits and effect-style tokens in colour slots', () => {
    expect(RectangleObjectSchema.safeParse({ ...rect, fill: 0x1000000 }).success).toBe(false)
    expect(
      RectangleObjectSchema.safeParse({ ...rect, fill: { $token: 'effectStyles.abc' } }).success,
    ).toBe(false)
  })

  it('bounds polygon sides to the renderer clamp [3, 12] and requires an integer', () => {
    const poly = VALID_OBJECTS.polygon
    const schema = slideObjectSchemaFor('polygon')
    expect(schema.safeParse({ ...poly, sides: 13 }).success).toBe(false)
    expect(schema.safeParse({ ...poly, sides: 2 }).success).toBe(false)
    expect(schema.safeParse({ ...poly, sides: 4.5 }).success).toBe(false)
    expect(schema.safeParse({ ...poly, sides: 12 }).success).toBe(true)

    const img = VALID_OBJECTS.image
    const r = slideObjectSchemaFor('image').safeParse({
      ...img,
      mask: { kind: 'polygon', sides: 2 },
    })
    expect(issuePaths(r)).toEqual([['mask', 'sides']])
  })

  it('rejects an empty asset id', () => {
    const r = slideObjectSchemaFor('image').safeParse({ ...VALID_OBJECTS.image, assetId: '' })
    expect(issuePaths(r)).toEqual([['assetId']])
  })
})

describe('hyperlinks', () => {
  const rect = VALID_OBJECTS.rectangle

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', '//evil.example', '  '])(
    'rejects unsafe href %j',
    (href) => {
      const r = RectangleObjectSchema.safeParse({ ...rect, hyperlink: { kind: 'url', href } })
      expect(issuePaths(r)).toEqual([['hyperlink', 'href']])
    },
  )

  it('stores the sanitised form of a safe href', () => {
    const out = RectangleObjectSchema.parse({
      ...rect,
      hyperlink: { kind: 'url', href: 'woodgrove.com/work' },
    })
    expect(out.hyperlink).toEqual({ kind: 'url', href: 'https://woodgrove.com/work' })
  })
})

describe('text', () => {
  const text = VALID_OBJECTS.text

  it('requires a positive font size', () => {
    expect(issuePaths(TextObjectSchema.safeParse({ ...text, fontSize: 0 }))).toEqual([['fontSize']])
  })

  it('rejects a font weight outside the scale', () => {
    expect(TextObjectSchema.safeParse({ ...text, fontWeight: 450 }).success).toBe(false)
    expect(TextObjectSchema.safeParse({ ...text, fontWeight: 'normal' }).success).toBe(true)
  })

  it('rejects duplicate and unknown text-style override keys', () => {
    const dup = TextObjectSchema.safeParse({ ...text, textStyleOverrides: ['color', 'color'] })
    expect(issuePaths(dup)).toEqual([['textStyleOverrides']])
    const unknown = TextObjectSchema.safeParse({ ...text, textStyleOverrides: ['vAlign'] })
    expect(issuePaths(unknown)).toEqual([['textStyleOverrides', 0]])
  })

  it('only accepts a plain-string body', () => {
    expect(TextObjectSchema.safeParse({ ...text, text: { toString: () => 'x' } }).success).toBe(
      false,
    )
  })
})

describe('ParagraphAttrsSchema', () => {
  it('accepts the documented bounds', () => {
    expect(
      ParagraphAttrsSchema.parse({
        list: 'number',
        level: 8,
        numberFormat: 'lowerRoman',
        startAt: 3,
      }),
    ).toEqual({ list: 'number', level: 8, numberFormat: 'lowerRoman', startAt: 3 })
  })

  it.each([
    [{ level: 9 }, ['level']],
    [{ level: 1.5 }, ['level']],
    [{ level: -1 }, ['level']],
    [{ startAt: 0 }, ['startAt']],
    [{ bulletChar: '' }, ['bulletChar']],
    [{ numberFormat: 'hebrew' }, ['numberFormat']],
  ])('rejects %j', (attrs, path) => {
    expect(issuePaths(ParagraphAttrsSchema.safeParse(attrs))).toEqual([path])
  })
})

describe('video', () => {
  it('requires trimEnd after trimStart', () => {
    const r = VideoObjectSchema.safeParse({ ...VALID_OBJECTS.video, trimStart: 5, trimEnd: 5 })
    expect(issuePaths(r)).toEqual([['trimEnd']])
  })

  it('bounds volume to [0, 1]', () => {
    expect(VideoObjectSchema.safeParse({ ...VALID_OBJECTS.video, volume: 1.1 }).success).toBe(false)
  })
})

describe('table grid invariants', () => {
  const table = VALID_OBJECTS.table

  it('rejects a row count that disagrees with rowHeights', () => {
    const r = TableObjectSchema.safeParse({ ...table, rowHeights: [60, 60, 60] })
    expect(issuePaths(r)).toEqual([['rows']])
  })

  it('rejects a row whose cell count disagrees with colWidths', () => {
    const rows = [table.rows[0], [{ text: 'only one' }]]
    expect(issuePaths(TableObjectSchema.safeParse({ ...table, rows }))).toEqual([['rows', 1]])
  })

  it('rejects spans and merge pointers that leave the grid', () => {
    const rows = [
      [{ text: 'a', gridSpan: 3 }, { text: 'b' }],
      [
        { text: 'c', rowSpan: 2 },
        { text: 'd', mergeOriginC: 1, mergeOriginR: 1 },
      ],
    ]
    const r = TableObjectSchema.safeParse({ ...table, rows })
    expect(issuePaths(r)).toEqual(
      expect.arrayContaining([
        ['rows', 0, 0, 'gridSpan'],
        ['rows', 1, 0, 'rowSpan'],
      ]),
    )
    // A pointer at itself is fine; only a pointer forward is wrong.
    expect(issuePaths(r)).toHaveLength(2)
  })

  it('rejects malformed and out-of-grid border segment keys', () => {
    const bad = TableObjectSchema.safeParse({
      ...table,
      borderSegments: { 'x:0:0': { color: 0, width: 1 } },
    })
    expect(issuePaths(bad)).toEqual([['borderSegments', 'x:0:0']])

    const outside = TableObjectSchema.safeParse({
      ...table,
      borderSegments: { 'h:3:0': { color: 0, width: 1 }, 'v:0:3': { color: 0, width: 1 } },
    })
    expect(issuePaths(outside)).toEqual([
      ['borderSegments', 'h:3:0'],
      ['borderSegments', 'v:0:3'],
    ])
  })

  it('rejects zero-size tracks', () => {
    const r = TableObjectSchema.safeParse({ ...table, colWidths: [160, 0] })
    expect(issuePaths(r)).toEqual([['colWidths', 1]])
  })
})
