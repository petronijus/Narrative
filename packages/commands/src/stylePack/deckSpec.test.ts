/**
 * deckSpec.test.ts — the deck spec (A5.2): its shape, and every problem
 * against the pack reported at once, by path; the example spec builds with
 * the rich example pack; text in the deck's language.
 */

import { describe, expect, it } from 'vitest'
import { richExampleStylePack } from '@narrative/shared'
import {
  DeckSpecSchema,
  exampleDeckSpec,
  inLanguage,
  validateDeckSpec,
  type DeckSpec,
} from './deckSpec.js'

const pack = richExampleStylePack()
const paths = (spec: DeckSpec) => validateDeckSpec(spec, pack).map((i) => i.path)

describe('deck spec', () => {
  it('the example spec has the shape and builds with the rich example pack', () => {
    const parsed = DeckSpecSchema.safeParse(exampleDeckSpec())
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(validateDeckSpec(exampleDeckSpec(), pack)).toEqual([])
  })

  it('takes exactly one of layout and archetype per slide, and a source for a sourced claim', () => {
    const slide = (s: Record<string, unknown>) =>
      DeckSpecSchema.safeParse({ ...exampleDeckSpec(), slides: [s] }).success
    expect(slide({ layout: 'title', archetype: 'cover' })).toBe(false)
    expect(slide({})).toBe(false)
    expect(slide({ layout: 'title', claims: [{ kind: 'sourced', text: 'x' }] })).toBe(false)
    expect(slide({ layout: 'title', claims: [{ kind: 'illustrative', text: 'x' }] })).toBe(true)
  })

  it('reports every problem against the pack at once, by path', () => {
    const spec: DeckSpec = {
      schemaVersion: 1,
      packId: 'other',
      variant: { background: 'pink', mood: 'calm' },
      lang: 'fr',
      fields: { client: 'Acme', date: 'today' },
      slides: [
        { layout: 'nope' },
        { archetype: 'process' },
        { layout: 'title', slots: { title: 'T', headline: 'x', subtitle: { assetId: 'a1' } } },
        { layout: 'two-columns', slots: { title: 'T', left: 'L' } },
        { layout: 'picture', slots: { picture: 'a caption' }, surface: 'band' },
        {
          layout: 'title-bullets',
          slots: { title: 'T' },
          drawn: [
            { kind: 'box', x: [0, 5], y: { band: 'content' }, height: 10, fill: 'color:pink' },
            { kind: 'text', x: [0, 0], y: { band: 'title' }, text: 'x', style: 'huge' },
          ],
        },
      ],
    }
    expect(paths(spec).sort()).toEqual(
      [
        'packId',
        'variant.background',
        'variant.mood',
        'lang',
        'fields.date',
        'slides.0.layout',
        'slides.1.archetype',
        'slides.2.slots.headline',
        'slides.2.slots.subtitle',
        'slides.3.slots.right',
        'slides.4.slots.picture',
        'slides.4.surface',
        'slides.5.drawn.0.x',
        'slides.5.drawn.0.fill',
        'slides.5.drawn.1.style',
      ].sort(),
    )
  })

  it('leaves a required picture to come later', () => {
    const spec: DeckSpec = { ...exampleDeckSpec(), slides: [{ archetype: 'picture' }] }
    expect(validateDeckSpec(spec, pack)).toEqual([])
  })

  it("takes text in the deck's language", () => {
    expect(inLanguage('Umsatz{de|en}Revenue', 'en')).toBe('Revenue')
    expect(inLanguage('Umsatz{de|en}Revenue', 'de')).toBe('Umsatz')
    expect(inLanguage('Umsatz{de|en}Revenue', undefined)).toBe('Umsatz')
    expect(inLanguage('Revenue', 'de')).toBe('Revenue')
    // Every paragraph and line on its own.
    const two =
      'Europa wächst{de|en}Europe grows\n\nAsien wächst{de|en}Asia grows\nLine{de|en}Zeile'
    expect(inLanguage(two, 'en')).toBe('Europe grows\n\nAsia grows\nZeile')
    expect(inLanguage(two, 'de')).toBe('Europa wächst\n\nAsien wächst\nLine')
  })
})
