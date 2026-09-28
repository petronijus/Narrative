import { describe, expect, it } from 'vitest'
import { harness } from '../testing/harness.js'
import { anchorsOnSlide, localToSlide, type PathPoint, type Placement } from '../geometry.js'

type Plain = Record<string, unknown>

function placement(o: Plain): Placement {
  return {
    x: o['x'] as number,
    y: o['y'] as number,
    width: o['width'] as number,
    height: o['height'] as number,
    rotation: o['rotation'] as number,
    flipH: o['flipH'] === true,
    flipV: o['flipV'] === true,
  }
}

function expectPointsClose(actual: PathPoint[], expected: PathPoint[]): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((a, i) => {
    const e = expected[i]!
    expect(a.x).toBeCloseTo(e.x, 9)
    expect(a.y).toBeCloseTo(e.y, 9)
    for (const k of ['cpIn', 'cpOut'] as const) {
      expect(a[k] === undefined).toBe(e[k] === undefined)
      if (a[k] !== undefined) {
        expect(a[k]!.x).toBeCloseTo(e[k]!.x, 9)
        expect(a[k]!.y).toBeCloseTo(e[k]!.y, 9)
      }
    }
  })
}

const S_CURVE: PathPoint[] = [
  { x: 300, y: 700, cpOut: { x: 150, y: -200 } },
  { x: 700, y: 700, cpIn: { x: -150, y: 200 } },
]

describe('object.path.create', () => {
  it('fits the box around the drawn curve, not its handles', () => {
    const h = harness()
    const out = h.run<Plain>('object.path.create', { slide: 's3', anchors: S_CURVE })
    // The S swings 100 / sqrt(3) px each way of y 700; the handles reach 200.
    const swing = 100 / Math.sqrt(3)
    expect(out['x']).toBe(300)
    expect(out['width']).toBe(400)
    expect(out['y'] as number).toBeCloseTo(700 - swing, 9)
    expect(out['height'] as number).toBeCloseTo(2 * swing, 9)
    const path = h.plain('s3', out['objectId'] as string)
    expectPointsClose(path['anchors'] as PathPoint[], [
      { x: 0, y: swing, cpOut: { x: 150, y: -200 } },
      { x: 400, y: swing, cpIn: { x: -150, y: 200 } },
    ])
  })

  it('draws the points where given even when rotated and mirrored', () => {
    const h = harness()
    const out = h.run<Plain>('object.path.create', {
      slide: 's3',
      anchors: S_CURVE,
      object: { rotation: 0.7, flipH: true, closed: true, fill: '#ff0000' },
    })
    const path = h.plain('s3', out['objectId'] as string)
    expect(path).toMatchObject({ closed: true, flipH: true, rotation: 0.7 })
    expectPointsClose(anchorsOnSlide(placement(path), path['anchors'] as PathPoint[]), S_CURVE)
  })
})

describe('object.path.fromShape', () => {
  it('keeps the id, the stacking place, the animation and the paint', () => {
    const h = harness()
    const order = (): string[] =>
      h
        .run<{ objects: Array<{ id: string }> }>('query.slide', { slide: 's1' })
        .objects.map((o) => o.id)
    const before = order()
    h.run('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { strokeDash: true, stroke: '#000000', strokeWidth: 2, rotation: 0.3, name: 'Card' },
    })
    expect(h.run('object.path.fromShape', { slide: 's1', object: 'r1' })).toEqual({
      objectId: 'r1',
      anchorCount: 4,
    })
    expect(order()).toEqual(before)
    const path = h.plain('s1', 'r1')
    expect(path).toMatchObject({
      type: 'path',
      closed: true,
      dash: true,
      fill: 0x4060e0,
      strokeWidth: 2,
      rotation: 0.3,
      name: 'Card',
    })
    // The outline fills the box, so the refitted box is the rectangle's.
    for (const [k, v] of Object.entries({ x: 100, y: 100, width: 200, height: 100 }))
      expect(path[k] as number).toBeCloseTo(v, 9)
    expect(path['strokeDash']).toBeUndefined()
    const query = h.run<{ animations: Array<{ id: string }> }>('query.object', {
      slide: 's1',
      object: 'r1',
    })
    expect(query.animations.map((a) => a.id)).toEqual(['a1'])
  })

  it('traces rounded corners as arcs, clamped like the renderer, and an ellipse as four arcs', () => {
    const h = harness()
    h.run('object.update', { slide: 's1', object: 'r1', patch: { cornerRadius: 500 } })
    h.run('object.path.fromShape', { slide: 's1', object: 'r1' })
    const anchors = h.plain('s1', 'r1')['anchors'] as PathPoint[]
    // 200 x 100: the radius clamps to 50, so the two arcs of a side meet.
    expect(anchors).toHaveLength(8)
    expect(anchors[0]).toMatchObject({ x: 0, y: 50 })
    expect(anchors[1]).toMatchObject({ x: 50, y: 0 })
    expect(anchors.every((a) => a.x >= 0 && a.x <= 200 && a.y >= 0 && a.y <= 100)).toBe(true)

    h.run('object.path.fromShape', { slide: 's1', object: 'e1' })
    const ellipse = h.plain('s1', 'e1')['anchors'] as PathPoint[]
    expect(ellipse).toHaveLength(4)
    expect(ellipse.every((a) => a.cpIn !== undefined && a.cpOut !== undefined)).toBe(true)
  })

  it('keeps a triangle exactly where the canvas draws it, the box refitted to it', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's3',
      object: { type: 'triangle', x: 100, y: 100, width: 300, height: 200, rotation: 0.5 },
    })
    const before = h.plain('s3', objectId)
    const drawn = [0, 1, 2].map((i) => {
      const t = -Math.PI / 2 + (i * 2 * Math.PI) / 3
      return localToSlide(placement(before), {
        x: 150 + 150 * Math.cos(t),
        y: 100 + 100 * Math.sin(t),
      })
    })
    h.run('object.path.fromShape', { slide: 's3', object: objectId })
    const after = h.plain('s3', objectId)
    expectPointsClose(anchorsOnSlide(placement(after), after['anchors'] as PathPoint[]), drawn)
    // The inscribed triangle is 3/4 of the box's height.
    expect(after['height'] as number).toBeCloseTo(150, 9)
  })

  it('refuses objects that are not parametric shapes', () => {
    const h = harness()
    expect(h.fail('object.path.fromShape', { slide: 's1', object: 't1' }).code).toBe('conflict')
    expect(h.fail('object.path.fromShape', { slide: 's2', object: 'pa1' }).code).toBe('conflict')
  })
})

describe('object.path.setAnchors', () => {
  it('moves one point of a turned, mirrored path; the others stay where they are drawn', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's2',
      object: 'pa1',
      patch: { rotation: 1.1, flipV: true },
    })
    const before = h.plain('s2', 'pa1')
    const onSlide = anchorsOnSlide(placement(before), before['anchors'] as PathPoint[])
    const moved = onSlide.map((a, i) => (i === 2 ? { ...a, x: a.x + 300, y: a.y - 120 } : a))
    h.run('object.path.setAnchors', { slide: 's2', object: 'pa1', anchors: moved })
    const after = h.plain('s2', 'pa1')
    expect(after).toMatchObject({ rotation: 1.1, flipV: true })
    expectPointsClose(anchorsOnSlide(placement(after), after['anchors'] as PathPoint[]), moved)
  })

  it('moves chosen anchors by index; the rest stay where they are drawn', () => {
    const h = harness()
    h.run('object.update', { slide: 's2', object: 'pa1', patch: { rotation: -0.4, flipH: true } })
    const before = h.plain('s2', 'pa1')
    const onSlide = anchorsOnSlide(placement(before), before['anchors'] as PathPoint[])
    h.run('object.path.setAnchors', {
      slide: 's2',
      object: 'pa1',
      moves: [{ index: 0, x: 1100, y: 950 }],
    })
    const after = h.plain('s2', 'pa1')
    expectPointsClose(anchorsOnSlide(placement(after), after['anchors'] as PathPoint[]), [
      { ...onSlide[0]!, x: 1100, y: 950 },
      onSlide[1]!,
      onSlide[2]!,
    ])
    expect(
      h.fail('object.path.setAnchors', {
        slide: 's2',
        object: 'pa1',
        moves: [{ index: 3, x: 0, y: 0 }],
      }).code,
    ).toBe('invalid_input')
  })

  it('only takes paths', () => {
    const h = harness()
    const anchors = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]
    expect(h.fail('object.path.setAnchors', { slide: 's1', object: 'r1', anchors }).code).toBe(
      'conflict',
    )
  })
})

describe('object.line.setEndpoints', () => {
  it('moves one end on a rotated line; the other stays where it is drawn', () => {
    const h = harness()
    h.run('object.rotate', { slide: 's2', objects: ['ln1'], degrees: 30 })
    const before = h.plain('s2', 'ln1')
    const p1 = localToSlide(placement(before), before['p1'] as PathPoint)
    const out = h.run<{ p1: PathPoint; p2: PathPoint }>('object.line.setEndpoints', {
      slide: 's2',
      object: 'ln1',
      p2: { x: 800, y: 300 },
    })
    const after = h.plain('s2', 'ln1')
    expect(after['rotation']).toBeCloseTo(Math.PI / 6, 9)
    const drawn = [after['p1'], after['p2']].map((p) =>
      localToSlide(placement(after), p as PathPoint),
    )
    expectPointsClose(drawn, [p1, { x: 800, y: 300 }])
    expectPointsClose([out.p1, out.p2], [p1, { x: 800, y: 300 }])
  })

  it('keeps a horizontal line flat (zero height) and refuses other types', () => {
    const h = harness()
    h.run('object.line.setEndpoints', { slide: 's2', object: 'ln1', p1: { x: 50, y: 900 } })
    expect(h.plain('s2', 'ln1')).toMatchObject({
      x: 50,
      y: 900,
      width: 450,
      height: 0,
      p1: { x: 0, y: 0 },
      p2: { x: 450, y: 0 },
    })
    expect(
      h.fail('object.line.setEndpoints', { slide: 's1', object: 'r1', p1: { x: 0, y: 0 } }).code,
    ).toBe('conflict')
  })
})
