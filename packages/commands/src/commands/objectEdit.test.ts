import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  getParagraphDeltas,
  getSlideObjectsCtx,
  listSlides,
  updateObject,
} from '@narrative/slide-model'
import { harness } from '../testing/harness.js'

const gradient12 = {
  kind: 'linearGradient',
  angleDeg: 90,
  stops: Array.from({ length: 12 }, (_, i) => ({ color: 0x101010 * (i % 10), offset: i / 11 })),
}

describe('object.create', () => {
  it('merges overrides over the registry defaults and converts hex colours', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's2',
      object: { type: 'rectangle', x: 10, fill: '#ff8800', stroke: '#abc' },
    })
    expect(h.plain('s2', objectId)).toMatchObject({
      type: 'rectangle',
      x: 10,
      y: 100,
      width: 200,
      height: 150,
      fill: 0xff8800,
      stroke: 0xaabbcc,
      rotation: 0,
      opacity: 1,
    })
  })

  it('takes a caller-chosen id, for every kind of object, and refuses one the slide has', () => {
    const h = harness()
    for (const [id, object] of [
      ['box-1', { type: 'rectangle' }],
      ['title_1', { type: 'text', text: { paragraphs: [{ runs: [{ text: 'Hi', bold: true }] }] } }],
      ['plain', { type: 'text', text: 'Hi' }],
      ['grid', { type: 'table', rows: 2, cols: 2 }],
    ] as const) {
      const out = h.run<{ objectId: string }>('object.create', { slide: 's2', id, object })
      expect(out.objectId).toBe(id)
      expect(h.plain('s2', id)).toMatchObject({ id, type: object.type })
    }
    const before = h.plain('s2', 'box-1')
    const clash = h.fail('object.create', { slide: 's2', id: 'box-1', object: { type: 'ellipse' } })
    expect(clash.code).toBe('conflict')
    expect(h.plain('s2', 'box-1')).toEqual(before)
    expect(
      h.fail('object.create', { slide: 's2', id: 'a/b', object: { type: 'ellipse' } }).code,
    ).toBe('invalid_input')
  })

  it('rejects unknown keys, wrong types and bad values without writing', () => {
    const h = harness()
    expect(
      h.fail('object.create', { slide: 's2', object: { type: 'rectangle', bogus: 1 } }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('object.create', { slide: 's2', object: { type: 'rectangle', opacity: 2 } }).code,
    ).toBe('invalid_input')
    expect(h.fail('object.create', { slide: 's2', object: { type: 'image' } }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('object.create', { slide: 's2', object: { type: 'sticker' } }).code).toBe(
      'invalid_input',
    )
    expect(
      h.fail('object.create', {
        slide: 's2',
        object: { type: 'video', assetId: 'v', trimStart: 5, trimEnd: 2 },
      }).code,
    ).toBe('invalid_input')
  })

  it('stores plain text with blank-line paragraphs as U+2029 and single newlines as soft breaks', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's2',
      object: { type: 'text', text: 'Title\nsubtitle\n\nBody' },
    })
    expect(h.text('s2', objectId).toString()).toBe(`Title\nsubtitle${PARAGRAPH_SEP}Body`)
    expect(h.text('s2', objectId).toDelta()).toEqual([
      { insert: `Title\nsubtitle${PARAGRAPH_SEP}Body` },
    ])
  })

  it('creates rich text identical to what text.set writes into an existing box', () => {
    const h = harness()
    const rich = {
      paragraphs: [
        {
          list: 'number',
          numberFormat: 'upperRoman',
          runs: [
            { text: 'Grow ', bold: true },
            { text: 'fast', italic: true, color: '#00ff00' },
          ],
        },
        { text: 'plain middle' },
        {
          list: 'bullet',
          level: 2,
          bulletChar: '–',
          runs: [{ text: 'deep', fontSize: 30, fontFamily: 'Inter' }],
        },
      ],
    }
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's2',
      object: { type: 'text', text: rich },
    })
    h.run('text.set', { target: { slide: 's1', object: 't1' }, text: rich })
    const created = getParagraphDeltas(h.text('s2', objectId))
    expect(created).toEqual(getParagraphDeltas(h.text('s1', 't1')))
    expect(created).toEqual([
      {
        ops: [
          { insert: 'Grow ', attributes: { fontWeight: 700 } },
          { insert: 'fast', attributes: { italic: true, color: 0x00ff00 } },
        ],
        attrs: { list: 'number', numberFormat: 'upperRoman' },
      },
      { ops: [{ insert: 'plain middle' }], attrs: {} },
      {
        ops: [{ insert: 'deep', attributes: { fontFamily: 'Inter', fontSize: 30 } }],
        attrs: { list: 'bullet', level: 2, bulletChar: '–' },
      },
    ])
    // The trailing separator carries the last paragraph's attributes.
    expect(h.text('s2', objectId).toString().endsWith(PARAGRAPH_SEP)).toBe(true)
  })

  it('creates a table through addTable with rows/cols, colour defaults and base overrides', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's3',
      object: {
        type: 'table',
        rows: 2,
        cols: 4,
        opacity: 0.5,
        name: 'Prices',
        defaults: { color: '#ff0000', fontSize: 30 },
      },
    })
    const t = h.plain('s3', objectId) as {
      rows: unknown[][]
      colWidths: number[]
      width: number
      height: number
      opacity: number
      name: string
      defaults: Record<string, unknown>
    }
    expect(t.rows).toHaveLength(2)
    expect(t.rows[0]).toHaveLength(4)
    expect(t.width).toBe(480)
    expect(t.height).toBe(120)
    expect(t.opacity).toBe(0.5)
    expect(t.name).toBe('Prices')
    expect(t.defaults).toMatchObject({
      color: 0xff0000,
      fontSize: 30,
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
    })
  })
})

describe('object.update', () => {
  it('rejects unknown keys and bad values before writing', () => {
    const h = harness()
    const e = h.fail('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { fill: '#00ff00', bogus: true },
    })
    expect(e.code).toBe('invalid_input')
    expect(e.issues.some((i) => i.path.join('.') === 'patch')).toBe(true)
    expect(
      h.fail('object.update', { slide: 's1', object: 'r1', patch: { opacity: 1.5 } }).code,
    ).toBe('invalid_input')
    // `fontSize` is not a rectangle property.
    expect(
      h.fail('object.update', { slide: 's1', object: 'r1', patch: { fontSize: 12 } }).code,
    ).toBe('invalid_input')
    // required properties cannot be removed
    expect(h.fail('object.update', { slide: 's1', object: 'r1', patch: { fill: null } }).code).toBe(
      'invalid_input',
    )
  })

  it('converts hex colours, accepts token refs and removes optional keys with null', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { stroke: '#123456', strokeWidth: 3, fill: { $token: 'colors.brand1' } },
    })
    expect(h.plain('s1', 'r1')).toMatchObject({
      stroke: 0x123456,
      strokeWidth: 3,
      fill: { $token: 'colors.brand1' },
    })
    h.run('object.update', { slide: 's1', object: 'r1', patch: { stroke: null } })
    expect(h.map('s1', 'r1').has('stroke')).toBe(false)
  })

  it('carries a cropped image crop along when the frame moves', () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 'img1', patch: { x: 1100, y: 150 } })
    expect(h.plain('s1', 'img1')).toMatchObject({
      x: 1100,
      y: 150,
      imageRect: { x: 1050, y: 100, width: 600, height: 450 },
    })
    // An explicit crop in the same patch wins.
    h.run('object.update', {
      slide: 's1',
      object: 'img1',
      patch: { x: 0, imageRect: { x: 5, y: 6, width: 7, height: 8 } },
    })
    expect(h.plain('s1', 'img1')).toMatchObject({
      x: 0,
      imageRect: { x: 5, y: 6, width: 7, height: 8 },
    })
  })

  it('validates only what the patch changes, so imported out-of-schema values do not block edits', () => {
    const h = harness()
    const objects = getSlideObjectsCtx(h.deck, 's1')!
    // An imported deck with a 12-stop gradient (the input schema allows 2..10).
    updateObject(objects, 'r1', { fillStyle: gradient12 } as never)
    h.run('object.update', { slide: 's1', object: 'r1', patch: { opacity: 0.4 } })
    expect(h.plain('s1', 'r1')).toMatchObject({
      opacity: 0.4,
      fillStyle: { stops: expect.any(Array) },
    })
    // …but a NEW 12-stop gradient is refused.
    expect(
      h.fail('object.update', { slide: 's1', object: 'e1', patch: { fillStyle: gradient12 } }).code,
    ).toBe('invalid_input')
  })

  it('checks the video trim window against the stored value', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's2',
      object: { type: 'video', assetId: 'v1', trimStart: 4 },
    })
    expect(
      h.fail('object.update', { slide: 's2', object: objectId, patch: { trimEnd: 3 } }).code,
    ).toBe('invalid_input')
    h.run('object.update', { slide: 's2', object: objectId, patch: { trimEnd: 9 } })
    expect(h.plain('s2', objectId)).toMatchObject({ trimStart: 4, trimEnd: 9 })
  })

  it('refuses table structure and points at the table commands', () => {
    const h = harness()
    const e = h.fail('object.update', {
      slide: 's1',
      object: 'tbl1',
      patch: { colWidths: [1, 2, 3] },
    })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toMatch(/table\./)
    h.run('object.update', { slide: 's1', object: 'tbl1', patch: { x: 50, opacity: 0.9 } })
    expect(h.plain('s1', 'tbl1')).toMatchObject({ x: 50, opacity: 0.9 })
  })

  it('replaces a text body with the same paragraph rules as text.set', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's1',
      object: 't1',
      patch: { text: 'One\n\nTwo', fontSize: 50 },
    })
    expect(h.text('s1', 't1').toDelta()).toEqual([{ insert: `One${PARAGRAPH_SEP}Two` }])
    expect(h.plain('s1', 't1')['fontSize']).toBe(50)
    expect(h.map('s1', 't1').get('text')).toBeInstanceOf(Y.Text)
  })

  it('updates several objects in one step, and validates all of them first', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's1',
      updates: [
        { object: 'r1', patch: { opacity: 0.3 } },
        { object: 'e1', patch: { fill: '#000000' } },
      ],
    })
    expect(h.plain('s1', 'r1')['opacity']).toBe(0.3)
    expect(h.plain('s1', 'e1')['fill']).toBe(0)
    const e = h.fail('object.update', {
      slide: 's1',
      updates: [
        { object: 'r1', patch: { opacity: 0.1 } },
        { object: 'e1', patch: { nope: 1 } },
      ],
    })
    expect(e.code).toBe('invalid_input')
    expect(e.issues[0]!.path.slice(0, 3)).toEqual(['updates', 1, 'patch'])
    expect(
      h.fail('object.update', {
        slide: 's1',
        updates: [
          { object: 'r1', patch: { opacity: 1 } },
          { object: 'r1', patch: { opacity: 0 } },
        ],
      }).code,
    ).toBe('invalid_input')
  })
})

describe('object.update — raw fields do exactly what they say (the description tells a model what to compose)', () => {
  it('does not scale a crop when width/height of a cropped image change', () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 'img1', patch: { width: 800, height: 600 } })
    expect(h.plain('s1', 'img1')).toMatchObject({
      width: 800,
      height: 600,
      imageRect: { x: 950, y: 150, width: 600, height: 450 },
    })
  })

  it('does not negate rotation on flipH / flipV; the editor flip is flip plus negated rotation in one patch', () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 'r1', patch: { rotation: 0.5 } })
    h.run('object.update', { slide: 's1', object: 'r1', patch: { flipH: true } })
    expect(h.plain('s1', 'r1')).toMatchObject({ flipH: true, rotation: 0.5 })
    h.run('object.update', { slide: 's1', object: 'e1', patch: { rotation: 0.5 } })
    h.run('object.update', { slide: 's1', object: 'e1', patch: { flipV: true, rotation: -0.5 } })
    expect(h.plain('s1', 'e1')).toMatchObject({ flipV: true, rotation: -0.5 })
  })

  it('keeps fontWeight when fontFamily changes (no snap to the family cuts)', () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 't1', patch: { fontWeight: 300 } })
    h.run('object.update', {
      slide: 's1',
      object: 't1',
      patch: { fontFamily: "Georgia, 'Times New Roman', serif" },
    })
    expect(h.plain('s1', 't1')).toMatchObject({
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontWeight: 300,
    })
  })

  it('only links a text style with textStyleId; the typography is untouched', () => {
    const h = harness()
    const before = h.plain('s1', 't1')
    h.run('object.update', { slide: 's1', object: 't1', patch: { textStyleId: 'style-heading' } })
    const after = h.plain('s1', 't1')
    expect(after['textStyleId']).toBe('style-heading')
    for (const key of [
      'fontFamily',
      'fontSize',
      'fontWeight',
      'color',
      'lineHeight',
      'letterSpacing',
    ]) {
      expect(after[key], key).toEqual(before[key])
    }
  })

  it('restyles formatted text box-wide by clearing the inline attribute and setting the box value in one ops.apply', () => {
    const h = harness()
    // "results" in t1 carries an inline fontWeight 700, which would win over any box weight.
    expect(
      h
        .text('s1', 't1')
        .toDelta()
        .some((op: { attributes?: object }) => op.attributes !== undefined),
    ).toBe(true)
    h.run('ops.apply', {
      ops: [
        {
          command: 'text.format',
          input: { target: { slide: 's1', object: 't1' }, clear: ['fontWeight'] },
        },
        {
          command: 'object.update',
          input: { slide: 's1', object: 't1', patch: { fontWeight: 300 } },
        },
      ],
    })
    expect(h.text('s1', 't1').toDelta()).toEqual([{ insert: 'Quarterly results' }])
    expect(h.plain('s1', 't1')['fontWeight']).toBe(300)
  })
})

describe('object.delete', () => {
  it('removes the objects and every animation step targeting them', () => {
    const h = harness()
    const out = h.run<{ deleted: string[]; removedAnimations: string[] }>('object.delete', {
      slide: 's1',
      objects: ['r1', 'e1'],
    })
    expect(out).toEqual({ deleted: ['r1', 'e1'], removedAnimations: ['a1', 'a2'] })
    const s1 = listSlides(h.deck)[0]!
    expect(s1.objects.map((o) => o.id)).not.toContain('r1')
    expect(s1.animations).toEqual([])
  })
})

describe('object.mask.apply / object.mask.remove', () => {
  it('clips the image to the shape, consumes the shape and its animations', () => {
    const h = harness()
    const out = h.run('object.mask.apply', { slide: 's1', image: 'img1', shape: 'e1' })
    expect(out).toEqual({ removedAnimations: ['a2'] })
    expect(h.plain('s1', 'img1')).toMatchObject({
      mask: { kind: 'ellipse' },
      x: 500,
      y: 100,
      width: 150,
      height: 150,
    })
    const s1 = listSlides(h.deck)[0]!
    expect(s1.objects.map((o) => o.id)).not.toContain('e1')
    expect(s1.animations.map((a) => a.id)).toEqual(['a1'])
  })

  it('refuses non-images and non-maskable shapes', () => {
    const h = harness()
    expect(h.fail('object.mask.apply', { slide: 's1', image: 'r1', shape: 'e1' }).code).toBe(
      'conflict',
    )
    expect(h.fail('object.mask.apply', { slide: 's1', image: 'img1', shape: 't1' }).code).toBe(
      'conflict',
    )
    expect(h.fail('object.mask.apply', { slide: 's1', image: 'img1', shape: 'img1' }).code).toBe(
      'invalid_input',
    )
  })

  it('removes a mask and keeps the frame; a second removal changes nothing', () => {
    const h = harness()
    expect(h.run('object.mask.remove', { slide: 's1', image: 'img2' })).toEqual({ removed: true })
    expect(h.map('s1', 'img2').has('mask')).toBe(false)
    expect(h.plain('s1', 'img2')).toMatchObject({ x: 1500, width: 200 })
    const before = Y.encodeStateVector(h.deck.doc)
    expect(h.run('object.mask.remove', { slide: 's1', image: 'img2' })).toEqual({ removed: false })
    expect(Y.encodeStateVector(h.deck.doc)).toEqual(before)
  })
})
