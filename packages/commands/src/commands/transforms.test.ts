import { describe, expect, it } from 'vitest'
import { harness } from '../testing/harness.js'

describe('object.resize', () => {
  it('grows from the top-left by default and keeps the other side', () => {
    const h = harness()
    expect(h.run('object.resize', { slide: 's1', object: 'r1', width: 300 })).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 100,
    })
  })

  it('keeps the anchor in place and the proportions when asked', () => {
    const h = harness()
    const out = h.run('object.resize', {
      slide: 's1',
      object: 'r1',
      width: 400,
      anchor: 'center',
      keepAspect: true,
    })
    // r1 is 200 x 100 at 100,100: centre 200,150.
    expect(out).toEqual({ x: 0, y: 50, width: 400, height: 200 })
  })

  it('scales a cropped picture with its frame', () => {
    const h = harness()
    // img1: frame 1000,200 400x300; crop 950,150 600x450 (1.5x, centred).
    h.run('object.resize', { slide: 's1', object: 'img1', width: 800, height: 600 })
    expect(h.plain('s1', 'img1')['imageRect']).toEqual({ x: 900, y: 100, width: 1200, height: 900 })
  })

  it('takes an exact box, and refuses a box mixed with an anchor', () => {
    const h = harness()
    h.run('object.resize', { slide: 's1', object: 'e1', x: 10, y: 20, width: 30, height: 40 })
    expect(h.plain('s1', 'e1')).toMatchObject({ x: 10, y: 20, width: 30, height: 40 })
    expect(
      h.fail('object.resize', {
        slide: 's1',
        object: 'e1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        anchor: 'center',
      }).code,
    ).toBe('invalid_input')
    expect(h.fail('object.resize', { slide: 's1', object: 'e1' }).code).toBe('invalid_input')
  })
})

describe('object.resize on point-drawn objects', () => {
  it('scales a line by its points and keeps a horizontal line flat', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's1',
      object: {
        type: 'line',
        x: 100,
        y: 500,
        width: 400,
        height: 0,
        p1: { x: 0, y: 0 },
        p2: { x: 400, y: 0 },
        stroke: '#000000',
        strokeWidth: 4,
      },
    })
    expect(h.run('object.resize', { slide: 's1', object: objectId, width: 800 })).toEqual({
      x: 100,
      y: 500,
      width: 800,
      height: 0,
    })
    expect(h.plain('s1', objectId)).toMatchObject({
      p1: { x: 0, y: 0 },
      p2: { x: 800, y: 0 },
      strokeWidth: 4,
    })
    // keepAspect on a flat line: the zero side stays zero.
    h.run('object.resize', { slide: 's1', object: objectId, width: 400, keepAspect: true })
    expect(h.plain('s1', objectId)).toMatchObject({ width: 400, height: 0, p2: { x: 400, y: 0 } })
  })

  it('scales a path by its anchors and their control points', () => {
    const h = harness()
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's1',
      object: {
        type: 'path',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        anchors: [
          { x: 0, y: 50, cpOut: { x: 20, y: -40 } },
          { x: 100, y: 0, cpIn: { x: -10, y: 10 }, moveTo: true },
        ],
        stroke: '#000000',
        strokeWidth: 2,
      },
    })
    h.run('object.resize', { slide: 's1', object: objectId, width: 200, height: 150 })
    expect(h.plain('s1', objectId)['anchors']).toEqual([
      { x: 0, y: 150, cpOut: { x: 40, y: -120 } },
      { x: 200, y: 0, cpIn: { x: -20, y: 30 }, moveTo: true },
    ])
  })
})

describe('object.rotate', () => {
  it('sets degrees, or adds them with relative', () => {
    const h = harness()
    h.run('object.rotate', { slide: 's1', objects: ['r1'], degrees: 90 })
    expect(h.plain('s1', 'r1')['rotation']).toBeCloseTo(Math.PI / 2, 9)
    const out = h.run<{ rotations: Array<{ degrees: number }> }>('object.rotate', {
      slide: 's1',
      objects: ['r1'],
      degrees: 45,
      relative: true,
    })
    expect(out.rotations[0]!.degrees).toBeCloseTo(135, 9)
  })
})

describe('object.flip', () => {
  it('toggles the mirror and negates the rotation, like the editor', () => {
    const h = harness()
    h.run('object.rotate', { slide: 's1', objects: ['r1'], degrees: 30 })
    h.run('object.flip', { slide: 's1', objects: ['r1'], axis: 'horizontal' })
    expect(h.plain('s1', 'r1')['flipH']).toBe(true)
    expect(h.plain('s1', 'r1')['rotation']).toBeCloseTo(-Math.PI / 6, 9)
    h.run('object.flip', { slide: 's1', objects: ['r1'], axis: 'horizontal' })
    expect(h.plain('s1', 'r1')['flipH']).toBeUndefined()
    expect(h.plain('s1', 'r1')['rotation']).toBeCloseTo(Math.PI / 6, 9)
  })
})

describe('object.alignToSlide', () => {
  it('centres one object and puts a block in a corner, keeping its layout', () => {
    const h = harness()
    h.run('object.alignToSlide', { slide: 's1', objects: ['r1'], horizontal: 'center' })
    expect(h.plain('s1', 'r1')).toMatchObject({ x: 860, y: 100 })

    const h2 = harness()
    // r1 100,100 200x100; e1 500,100 150x150 -> block 100..650 x 100..250
    h2.run('object.alignToSlide', {
      slide: 's1',
      objects: ['r1', 'e1'],
      horizontal: 'right',
      vertical: 'bottom',
    })
    expect(h2.plain('s1', 'r1')).toMatchObject({ x: 1370, y: 930 })
    expect(h2.plain('s1', 'e1')).toMatchObject({ x: 1770, y: 930 })
  })

  it('aligns what is visible: a rotated object touches the edge with its outline', () => {
    const h = harness()
    h.run('object.rotate', { slide: 's1', objects: ['r1'], degrees: 90 })
    h.run('object.alignToSlide', { slide: 's1', objects: ['r1'], horizontal: 'left' })
    // 200 x 100 turned 90 degrees covers 100 px of width, centred on the box centre.
    const r1 = h.plain('s1', 'r1') as { x: number; width: number }
    expect(r1.x + r1.width / 2 - 50).toBeCloseTo(0, 9)
  })

  it('moves a crop with its image', () => {
    const h = harness()
    h.run('object.alignToSlide', { slide: 's1', objects: ['img1'], vertical: 'top' })
    expect(h.plain('s1', 'img1')['imageRect']).toEqual({ x: 950, y: -50, width: 600, height: 450 })
  })
})

describe('object.crop.set', () => {
  it('pans, zooms around a point, sets and resets the picture, frame untouched', () => {
    const h = harness()
    // img1 picture relative to its frame: -50,-50 600x450.
    expect(
      h.run('object.crop.set', { slide: 's1', image: 'img1', crop: { op: 'pan', dx: 10, dy: 0 } }),
    ).toEqual({ picture: { x: -40, y: -50, width: 600, height: 450 }, degrees: 0 })
    expect(
      h.run('object.crop.set', {
        slide: 's1',
        image: 'img1',
        crop: { op: 'zoom', factor: 2, around: { x: 0, y: 0 } },
      }),
    ).toEqual({ picture: { x: -80, y: -100, width: 1200, height: 900 }, degrees: 0 })
    h.run('object.crop.set', {
      slide: 's1',
      image: 'img1',
      crop: { op: 'set', picture: { x: 0, y: 0, width: 400, height: 300 } },
    })
    expect(h.plain('s1', 'img1')['imageRect']).toEqual({ x: 1000, y: 200, width: 400, height: 300 })
    h.run('object.crop.set', { slide: 's1', image: 'img1', crop: { op: 'reset' } })
    expect(h.plain('s1', 'img1')['imageRect']).toBeUndefined()
    expect(h.plain('s1', 'img1')).toMatchObject({ x: 1000, y: 200, width: 400, height: 300 })
  })

  it('turns the picture inside the frame, and reset straightens it', () => {
    const h = harness()
    h.run('object.crop.set', { slide: 's1', image: 'img1', crop: { op: 'rotate', degrees: 15 } })
    expect(h.plain('s1', 'img1')['imageRotation']).toBeCloseTo(Math.PI / 12, 9)
    const out = h.run<{ degrees: number }>('object.crop.set', {
      slide: 's1',
      image: 'img1',
      crop: { op: 'rotate', degrees: 15, relative: true },
    })
    expect(out.degrees).toBeCloseTo(30, 9)
    h.run('object.crop.set', { slide: 's1', image: 'img1', crop: { op: 'reset' } })
    expect(h.plain('s1', 'img1')['imageRotation']).toBeUndefined()
  })

  it('refuses anything but an image', () => {
    const h = harness()
    expect(
      h.fail('object.crop.set', { slide: 's1', image: 'r1', crop: { op: 'reset' } }).code,
    ).toBe('conflict')
  })
})
