import { describe, expect, it } from 'vitest'
import { harness } from '../testing/harness.js'
import { FIXTURE_PAGE_NUMBER_STYLE_ID } from '../testing/fixtureTokens.js'
import { seedGradientStops } from './appearance.js'

describe('object.fill.gradient', () => {
  it("starts a new gradient from the shape's colour and a darker tint of it", () => {
    const h = harness()
    // r1 is filled 0x4060e0: 0x40*0.55 = 0x23, 0x60*0.55 = 0x35, 0xe0*0.55 = 0x7b.
    h.run('object.fill.gradient', { slide: 's1', objects: ['r1'], kind: 'linear' })
    expect(h.plain('s1', 'r1')['fillStyle']).toEqual({
      kind: 'linearGradient',
      stops: [
        { color: 0x4060e0, offset: 0 },
        { color: 0x23357b, offset: 1 },
      ],
      angleDeg: 0,
    })
  })

  it('keeps the stops when switching kind or changing only the angle or centre', () => {
    const h = harness()
    h.run('object.fill.gradient', {
      slide: 's1',
      objects: ['e1'],
      kind: 'linear',
      stops: [
        { color: '#ffd166', offset: 0 },
        { color: '#ef476f', offset: 0.8, alpha: 0.5 },
      ],
      angle: 45,
    })
    h.run('object.fill.gradient', { slide: 's1', objects: ['e1'], kind: 'linear', angle: 90 })
    const stops = [
      { color: 0xffd166, offset: 0 },
      { color: 0xef476f, offset: 0.8, alpha: 0.5 },
    ]
    expect(h.plain('s1', 'e1')['fillStyle']).toEqual({
      kind: 'linearGradient',
      stops,
      angleDeg: 90,
    })
    h.run('object.fill.gradient', {
      slide: 's1',
      objects: ['e1'],
      kind: 'radial',
      center: { x: 0.25, y: 0.75 },
    })
    h.run('object.fill.gradient', { slide: 's1', objects: ['e1'], kind: 'radial' })
    expect(h.plain('s1', 'e1')['fillStyle']).toEqual({
      kind: 'radialGradient',
      stops,
      centerX: 0.25,
      centerY: 0.75,
    })
  })

  it('unlinks a token fill to its current colour and seeds from it', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { fill: { $token: 'colors.brandBlue' } },
    })
    h.run('object.fill.gradient', { slide: 's1', objects: ['r1'], kind: 'radial' })
    const r1 = h.plain('s1', 'r1')
    expect(r1['fill']).toBe(0x2040c0)
    expect(r1['fillStyle']).toEqual({ kind: 'radialGradient', stops: seedGradientStops(0x2040c0) })
  })

  it('refuses to guess a token colour it cannot resolve, unless stops are given', () => {
    const h = harness()
    h.run('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { fill: { $token: 'colors.gone' } },
    })
    expect(
      h.fail('object.fill.gradient', { slide: 's1', objects: ['r1'], kind: 'linear' }).code,
    ).toBe('invalid_input')
    delete h.ctx.folderTokens
    h.run('object.update', {
      slide: 's1',
      object: 'r1',
      patch: { fill: { $token: 'colors.brandBlue' } },
    })
    expect(
      h.fail('object.fill.gradient', { slide: 's1', objects: ['r1'], kind: 'linear' }).code,
    ).toBe('conflict')
    h.run('object.fill.gradient', {
      slide: 's1',
      objects: ['r1'],
      kind: 'linear',
      stops: [
        { color: '#000', offset: 0 },
        { color: '#fff', offset: 1 },
      ],
    })
    expect(h.plain('s1', 'r1')['fill']).toEqual({ $token: 'colors.brandBlue' })
  })

  it('refuses objects without a fill style and options of the other kind', () => {
    const h = harness()
    expect(
      h.fail('object.fill.gradient', { slide: 's1', objects: ['t1'], kind: 'linear' }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('object.fill.gradient', { slide: 's1', objects: ['r1', 'img1'], kind: 'linear' }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('object.fill.gradient', {
        slide: 's1',
        objects: ['r1'],
        kind: 'linear',
        center: { x: 0.5, y: 0.5 },
      }).code,
    ).toBe('invalid_input')
    expect(
      h.fail('object.fill.gradient', { slide: 's1', objects: ['r1'], kind: 'radial', angle: 10 })
        .code,
    ).toBe('invalid_input')
  })
})

describe('object.effects.shadow', () => {
  it("switches on the editor's default shadow and merges changes into it", () => {
    const h = harness()
    h.run('object.effects.shadow', { slide: 's1', objects: ['r1', 'e1'], shadow: {} })
    const byDefault = { color: 0, blur: 8, offsetX: 4, offsetY: 4, opacity: 0.5 }
    expect(h.plain('s1', 'r1')['shadow']).toEqual(byDefault)
    expect(h.plain('s1', 'e1')['shadow']).toEqual(byDefault)
    h.run('object.effects.shadow', {
      slide: 's1',
      objects: ['r1'],
      shadow: { blur: 20, color: '#ff0000' },
    })
    expect(h.plain('s1', 'r1')['shadow']).toEqual({ ...byDefault, blur: 20, color: 0xff0000 })
  })

  it('takes a colour token and removes a shadow with null', () => {
    const h = harness()
    h.run('object.effects.shadow', {
      slide: 's1',
      objects: ['t1'],
      shadow: { color: { $token: 'colors.ink' }, offsetY: 12 },
    })
    expect(h.plain('s1', 't1')['shadow']).toMatchObject({
      color: { $token: 'colors.ink' },
      offsetY: 12,
    })
    h.run('object.effects.shadow', { slide: 's1', objects: ['t1'], shadow: null })
    expect(h.plain('s1', 't1')).not.toHaveProperty('shadow')
  })

  it('refuses an unknown object without touching the others', () => {
    const h = harness()
    expect(
      h.fail('object.effects.shadow', { slide: 's1', objects: ['r1', 'nope'], shadow: {} }).code,
    ).toBe('not_found')
  })
})

describe('object.slideNumber.set', () => {
  it('turns a text box into the page number and back', () => {
    const h = harness()
    expect(h.run('object.slideNumber.set', { slide: 's1', object: 't1', on: true })).toEqual({
      otherPageNumberInDeck: false,
      pageNumberStyle: { id: FIXTURE_PAGE_NUMBER_STYLE_ID, name: 'Footnotes and pages' },
    })
    expect(h.plain('s1', 't1')['isSlideNumber']).toBe(true)
    h.run('object.slideNumber.set', { slide: 's1', object: 't1', on: false })
    expect(h.plain('s1', 't1')).not.toHaveProperty('isSlideNumber')
  })

  it("links and applies the folder's page-number style, resolving its colour token", () => {
    const h = harness()
    h.run('object.slideNumber.set', { slide: 's1', object: 't1', on: true, applyTextStyle: true })
    expect(h.plain('s1', 't1')).toMatchObject({
      isSlideNumber: true,
      textStyleId: FIXTURE_PAGE_NUMBER_STYLE_ID,
      textStyleOverrides: [],
      fontFamily: 'Inter',
      fontWeight: 400,
      fontSize: 14,
      lineHeight: 1.2,
      letterSpacing: 0.5,
      paragraphSpaceBefore: 0,
      paragraphSpaceAfter: 0,
      color: 0x222222,
      textTransform: 'uppercase',
    })
  })

  it('reports another page number in the deck', () => {
    const h = harness()
    h.run('object.slideNumber.set', { slide: 's1', object: 't1', on: true })
    const { objectId } = h.run<{ objectId: string }>('object.create', {
      slide: 's2',
      object: { type: 'text', text: '2', x: 1800, y: 1000, width: 60, height: 40 },
    })
    expect(
      h.run('object.slideNumber.set', { slide: 's2', object: objectId, on: true })[
        'otherPageNumberInDeck'
      ],
    ).toBe(true)
  })

  it('refuses a non-text object, a missing style and a style without on', () => {
    const h = harness()
    expect(h.fail('object.slideNumber.set', { slide: 's1', object: 'r1', on: true }).code).toBe(
      'invalid_input',
    )
    expect(
      h.fail('object.slideNumber.set', {
        slide: 's1',
        object: 't1',
        on: false,
        applyTextStyle: true,
      }).code,
    ).toBe('invalid_input')
    h.ctx.folderTokens = { colors: {}, textStyles: {}, effectStyles: {} }
    expect(
      h.fail('object.slideNumber.set', {
        slide: 's1',
        object: 't1',
        on: true,
        applyTextStyle: true,
      }).code,
    ).toBe('not_found')
    delete h.ctx.folderTokens
    expect(
      h.fail('object.slideNumber.set', {
        slide: 's1',
        object: 't1',
        on: true,
        applyTextStyle: true,
      }).code,
    ).toBe('conflict')
    expect(h.run('object.slideNumber.set', { slide: 's1', object: 't1', on: true })).toMatchObject({
      pageNumberStyle: null,
    })
  })
})
