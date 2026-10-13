import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  getSlideNotesFragment,
  listSlides,
  setDeckMeta,
  setSlideLayout,
} from '@narrative/slide-model'
import { harness } from '../testing/harness.js'

/** A value survives JSON unchanged iff it holds nothing but JSON (no Y types, no undefined, no class instances). */
function jsonRoundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

describe('query.deck', () => {
  it('outlines every slide with a title guess, counts and the guides', () => {
    const h = harness()
    h.run('slide.rename', { slide: 's2', name: 'Numbers' })
    h.run('slide.skip', { slide: 's3', skipped: true })
    const out = h.run<Record<string, unknown>>('query.deck', {})
    expect(jsonRoundTrip(out)).toEqual(out)
    expect(out).toEqual({
      slideCount: 3,
      slides: [
        {
          id: 's1',
          index: 0,
          title: 'Quarterly results',
          transition: 'none',
          objectCount: 9,
          animationCount: 2,
        },
        {
          id: 's2',
          index: 1,
          name: 'Numbers',
          title: 'Results',
          transition: 'none',
          objectCount: 8,
          animationCount: 0,
        },
        {
          id: 's3',
          index: 2,
          skipped: true,
          transition: 'none',
          objectCount: 0,
          animationCount: 0,
        },
      ],
      guides: [{ id: 'gd1', orientation: 'vertical', position: 960 }],
      meta: {},
    })
  })

  it("reads the deck's meta and each slide's pack layout (A4)", () => {
    const h = harness()
    setDeckMeta(h.deck.doc, { variant: { theme: 'dark' }, fields: { client: 'Acme' }, lang: 'de' })
    const s1 = listSlides(h.deck)[0]!.id
    setSlideLayout(h.deck, s1, { packId: 'p', layoutId: 'title', surface: 'band' })
    const deck = h.run<{ meta: unknown; slides: Array<{ layout?: unknown }> }>('query.deck', {})
    expect(deck.meta).toEqual({ variant: { theme: 'dark' }, fields: { client: 'Acme' }, lang: 'de' })
    expect(deck.slides[0]!.layout).toEqual({ packId: 'p', layoutId: 'title', surface: 'band' })
    expect(deck.slides[1]?.layout).toBeUndefined()
    const slide = h.run<{ layout?: unknown }>('query.slide', { slide: { index: 0 } })
    expect(slide.layout).toEqual({ packId: 'p', layoutId: 'title', surface: 'band' })
  })
})

describe('query.slide', () => {
  it('returns plain JSON: no Y types, colours as hex, formatted text with paragraphs', () => {
    const h = harness()
    h.run('slide.setBackground', { slide: 's1', background: { kind: 'color', color: '#102030' } })
    const out = h.run<{
      objects: Array<Record<string, unknown>>
      background: unknown
      animations: unknown[]
    }>('query.slide', { slide: 's1' })
    expect(jsonRoundTrip(out)).toEqual(out)
    const byId = new Map(out.objects.map((o) => [o['id'], o]))
    expect(byId.get('r1')).toMatchObject({ type: 'rectangle', fill: '#4060e0' })
    expect(byId.get('t1')).toMatchObject({
      text: 'Quarterly results',
      color: '#111111',
      paragraphs: [{ runs: [{ text: 'Quarterly ' }, { text: 'results', fontWeight: 700 }] }],
    })
    expect(byId.get('t2')).toMatchObject({
      text: 'Revenue\n\nCosts\n\nMargin',
      paragraphs: [
        { runs: [{ text: 'Revenue' }], list: 'bullet' },
        { runs: [{ text: 'Costs' }], list: 'bullet' },
        { runs: [{ text: 'Margin' }], list: 'bullet' },
      ],
    })
    const tbl = byId.get('tbl1') as {
      rows: Array<Array<{ text: string }>>
      defaults: { color: string; border: { color: string } }
    }
    expect(tbl.rows[0]![0]).toEqual({ text: '' })
    expect(tbl.defaults.color).toBe('#111111')
    expect(tbl.defaults.border.color).toBe('#cccccc')
    expect(out.background).toEqual({ kind: 'color', color: '#102030', alpha: 1 })
    expect(out.animations).toHaveLength(2)
  })

  it('reads the speaker notes as plain text without writing', () => {
    const h = harness()
    const notes = getSlideNotesFragment(h.deck, 's2')!
    h.deck.doc.transact(() => {
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, 'Mention the Q3 dip')
      p.insert(0, [t])
      notes.insert(0, [p])
    })
    const before = Y.encodeStateVector(h.deck.doc)
    expect(h.run<{ notes: string }>('query.slide', { slide: 's2' }).notes).toBe(
      'Mention the Q3 dip',
    )
    expect(Y.encodeStateVector(h.deck.doc)).toEqual(before)
  })

  it('an empty slide reads as an empty slide with the default background', () => {
    const h = harness()
    expect(h.run('query.slide', { slide: { index: 2 } })).toEqual({
      id: 's3',
      index: 2,
      transition: { kind: 'none', durationMs: 0 },
      background: null,
      objects: [],
      animations: [],
      notes: '',
    })
  })
})

describe('query.object', () => {
  it('returns one object, its stacking position and its animations', () => {
    const h = harness()
    const out = h.run<Record<string, unknown>>('query.object', { slide: 's1', object: 'r1' })
    expect(jsonRoundTrip(out)).toEqual(out)
    expect(out).toMatchObject({
      slide: { id: 's1', index: 0 },
      stackIndex: 0,
      object: { id: 'r1', type: 'rectangle', x: 100, fill: '#4060e0' },
      animations: [{ id: 'a1', objectId: 'r1', preset: 'fadeIn' }],
    })
  })

  it('what a model reads it can write back unchanged', () => {
    const h = harness()
    const read = h.run<{ object: Record<string, unknown> }>('query.object', {
      slide: 's1',
      object: 'e1',
    })
    const { id: _id, type: _type, ...props } = read.object
    void _id
    void _type
    const before = listSlides(h.deck)[0]!.objects.find((o) => o.id === 'e1')
    h.run('object.update', { slide: 's1', object: 'e1', patch: props })
    expect(listSlides(h.deck)[0]!.objects.find((o) => o.id === 'e1')).toEqual(before)
  })
})
