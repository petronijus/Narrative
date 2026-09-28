import { describe, expect, it } from 'vitest'
import { harness } from '../testing/harness.js'

type Obj = Record<string, unknown>

/** What a copy may differ in: its id and the id of its (new) group. */
function comparable(o: Obj): Obj {
  const { id: _id, groupId, ...rest } = o
  void _id
  return groupId === undefined ? rest : { ...rest, grouped: true }
}

describe('object.insert', () => {
  it('recreates a whole slide read with query.slide, formatting, tables and crops included', () => {
    const h = harness()
    const source = h.run<{ objects: Obj[] }>('query.slide', { slide: 's1' }).objects
    const out = h.run<{ objectIds: string[] }>('object.insert', { slide: 's3', objects: source })
    expect(out.objectIds).toHaveLength(source.length)
    const copies = h.run<{ objects: Obj[] }>('query.slide', { slide: 's3' }).objects
    expect(copies.map(comparable)).toEqual(source.map(comparable))
    // The copied group is a new group of its own, shared by both members.
    const groups = new Set(
      copies.filter((o) => o['groupId'] !== undefined).map((o) => o['groupId']),
    )
    expect(groups.size).toBe(1)
    expect(groups.has('grp1')).toBe(false)
  })

  it('places the block with `at` and carries a crop along', () => {
    const h = harness()
    const [img] = h
      .run<{ objects: Obj[] }>('query.slide', { slide: 's1' })
      .objects.filter((o) => o['id'] === 'img1')
    // img1: frame 1000,200 400 x 300 → centre 1200,350.
    const out = h.run<{ objectIds: string[] }>('object.insert', {
      slide: 's3',
      objects: [img!],
      at: { x: 300, y: 250 },
    })
    const copy = h.plain('s3', out.objectIds[0]!)
    expect(copy).toMatchObject({ x: 100, y: 100 })
    expect(copy['imageRect']).toEqual({ x: 50, y: 50, width: 600, height: 450 })
  })

  it('refuses invalid objects before writing anything, naming the field', () => {
    const h = harness()
    const err = h.fail('object.insert', {
      slide: 's3',
      objects: [
        { type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
        { type: 'rectangle', x: 0, y: 0, width: -5, height: 10 },
      ],
    })
    expect(err.code).toBe('invalid_input')
    expect(err.issues?.[0]?.path).toEqual(['objects', 1, 'width'])
    expect(h.run<{ objects: Obj[] }>('query.slide', { slide: 's3' }).objects).toEqual([])
    expect(
      h.fail('object.insert', { slide: 's3', objects: [{ type: 'hologram' }] }).issues?.[0]?.path,
    ).toEqual(['objects', 0, 'type'])
  })

  it('refuses a table whose tracks do not match its cells', () => {
    const h = harness()
    const [tbl] = h
      .run<{ objects: Obj[] }>('query.slide', { slide: 's1' })
      .objects.filter((o) => o['type'] === 'table')
    const broken = { ...tbl!, colWidths: [100] }
    expect(h.fail('object.insert', { slide: 's3', objects: [broken] }).issues?.[0]?.path).toEqual([
      'objects',
      0,
      'colWidths',
    ])
  })
})

describe('object.insert — what object.create would refuse is refused', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'a video that ends before it starts',
      { type: 'video', assetId: 'asset-fixture', trimStart: 5, trimEnd: 2 },
    ],
    ['an image without its picture', { type: 'image', x: 0, y: 0, width: 10, height: 10 }],
    [
      'a table whose widths do not match its default grid',
      { type: 'table', colWidths: [1, 1, 1, 1, 1] },
    ],
    ['a table with heights but no rows', { type: 'table', rowHeights: [10] }],
  ]
  it.each(cases)('%s', (_name, object) => {
    const h = harness()
    expect(h.fail('object.insert', { slide: 's3', objects: [object] }).code).toBe('invalid_input')
    expect(h.run<{ objects: Obj[] }>('query.slide', { slide: 's3' }).objects).toEqual([])
  })

  it('a merge running off the grid, and more than 100 rows', () => {
    const h = harness()
    const [tbl] = h
      .run<{ objects: Obj[] }>('query.slide', { slide: 's1' })
      .objects.filter((o) => o['type'] === 'table')
    const rows = tbl!['rows'] as Array<Array<Record<string, unknown>>>
    const offGrid = {
      ...tbl!,
      rows: rows.map((r, ri) =>
        r.map((c, ci) => (ri === 0 && ci === 0 ? { ...c, gridSpan: 9 } : c)),
      ),
    }
    expect(h.fail('object.insert', { slide: 's3', objects: [offGrid] }).code).toBe('invalid_input')
    const huge = {
      ...tbl!,
      rows: Array.from({ length: 101 }, () => rows[0]),
      rowHeights: Array.from({ length: 101 }, () => 10),
    }
    expect(h.fail('object.insert', { slide: 's3', objects: [huge] }).issues?.[0]?.path).toEqual([
      'objects',
      0,
      'rows',
    ])
  })
})

describe('object.copyTo', () => {
  it('copies exactly onto another slide and keeps the position there', () => {
    const h = harness()
    const out = h.run<{ objectIds: string[] }>('object.copyTo', {
      slide: 's1',
      objects: ['t1', 'img1'],
      toSlide: 's3',
    })
    const copies = h.run<{ objects: Obj[] }>('query.slide', { slide: 's3' }).objects
    const source = h
      .run<{ objects: Obj[] }>('query.slide', { slide: 's1' })
      .objects.filter((o) => o['id'] === 't1' || o['id'] === 'img1')
    expect(copies.map((o) => o['id'])).toEqual(out.objectIds)
    expect(copies.map(comparable)).toEqual(source.map(comparable))
  })

  it('moves 20, 20 on the same slide by default, like duplicate', () => {
    const h = harness()
    const out = h.run<{ objectIds: string[] }>('object.copyTo', { slide: 's1', objects: ['r1'] })
    expect(h.plain('s1', out.objectIds[0]!)).toMatchObject({ x: 120, y: 120 })
  })
})
