/**
 * buildPlan.test.ts — a deck spec as a plan per slide (A5.2): the example
 * spec on an empty deck, page numbers in the spec's order, the deck's
 * language, what is drawn on the grid, which deck slides the build reuses,
 * replaces or leaves past its end, and a spec that does not build.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { richExampleStylePack, type SlideObject } from '@narrative/shared'
import {
  addObject,
  getSlideObjectsCtx,
  listSlides,
  type FolderTokensSnapshot,
} from '@narrative/slide-model'
import { harness } from '../testing/harness.js'
import { withCompiledPack } from '../testing/fixtureTokens.js'
import { CommandError } from '../errors.js'
import { planBuild, specSlideKey, type BuildDeckSlide } from './buildPlan.js'
import { exampleDeckSpec, type DeckSpec } from './deckSpec.js'

const pack = richExampleStylePack()
const tokens = (): FolderTokensSnapshot =>
  withCompiledPack({ colors: {}, textStyles: {}, effectStyles: {} }, pack)

/** A deck slide with no objects. */
const empty = (id: string): BuildDeckSlide => ({ id, objects: [] })

const textOf = (o: SlideObject | undefined): string =>
  String((o as unknown as Record<string, unknown> | undefined)?.['text'] ?? '')

describe('planBuild', () => {
  it('builds the example spec on an empty deck: the first slide reused, the rest new', () => {
    const out = planBuild({
      spec: exampleDeckSpec(),
      pack,
      tokens: tokens(),
      slides: [empty('s1')],
    })
    expect(out.slides.map((s) => s.layoutId)).toEqual([
      'title',
      'agenda',
      'title-bullets',
      'two-columns',
      'quote',
      'closer',
    ])
    expect(out.slides.map((s) => s.archetype)).toEqual([
      'cover',
      'agenda',
      'content',
      // Named by layout: the first archetype the pack maps two-columns to.
      'content',
      'statement',
      'closer',
    ])
    expect(out.slides[0]!.slideId).toBe('s1')
    expect(out.slides.slice(1).every((s) => s.slideId === undefined)).toBe(true)
    expect(out).toMatchObject({ superseded: [], handMade: [] })
    expect(out.meta).toEqual({
      variant: { background: 'light' },
      fields: { client: 'Acme' },
      lang: 'en',
    })
    // Notes and the brief travel with the slide.
    expect(out.slides[2]).toMatchObject({
      notes: 'Start with **Asia**: the fastest growth.',
      brief: {
        message: 'Every region grew',
        claims: [{ kind: 'sourced', source: 'Q3 finance report' }],
      },
    })
  })

  it("numbers pages by the spec's order and writes the deck's language", () => {
    const spec: DeckSpec = { ...exampleDeckSpec(), lang: 'de' }
    const out = planBuild({ spec, pack, tokens: tokens(), slides: [] })
    const footer = out.slides[2]!.plan.add.find((o) => o.slot === 'footer')
    expect(textOf(footer)).toBe('Acme | Seite 3')
    const subtitle = out.slides[0]!.plan.add.find((o) => o.slot === 'subtitle')
    expect(textOf(subtitle)).toBe('Vorstandssitzung')
  })

  it("draws on the pack's grid, linked to its tokens", () => {
    const out = planBuild({ spec: exampleDeckSpec(), pack, tokens: tokens(), slides: [] })
    const rule = out.slides[3]!.plan.add.find((o) => o.slot === 'drawn-1')!
    // Columns 0..1 of the grid (120..1800), the content band (300) less 20.
    expect(rule).toMatchObject({ type: 'line', x: 120, y: 280, width: 1680 })
    expect((rule as unknown as { stroke: unknown }).stroke).toEqual({
      $token: expect.stringMatching(/^colors\./),
    })
  })

  it('keeps the slides an unchanged spec slide built, and builds a changed one fresh', () => {
    const spec = exampleDeckSpec()
    const key = (i: number) => specSlideKey(spec.slides[i]!, spec.packId, spec.lang)
    // The deck an earlier build made: slides 0..5 carry their spec slides' keys.
    const deck: BuildDeckSlide[] = spec.slides.map((_, i) => ({
      id: `d${i}`,
      specKey: key(i),
      objects: [],
    }))
    // A slide inserted at 1, and slide 2 (was 1) rewritten.
    const next: DeckSpec = {
      ...spec,
      slides: [
        spec.slides[0]!,
        { archetype: 'content', slots: { title: 'New one', bullets: 'x' } },
        { ...spec.slides[1]!, message: 'changed' },
        ...spec.slides.slice(2),
      ],
    }
    const out = planBuild({ spec: next, pack, tokens: tokens(), slides: deck })
    expect(out.slides.map((s) => s.slideId)).toEqual([
      'd0',
      undefined,
      undefined,
      'd2',
      'd3',
      'd4',
      'd5',
    ])
    expect(out.slides.map((s) => s.kept)).toEqual([true, false, false, true, true, true, true])
    // The changed slide's old self goes, freely: it was the build's own.
    expect(out).toMatchObject({ superseded: ['d1'], handMade: [] })
    // Another pack or language is another slide.
    expect(specSlideKey(spec.slides[0]!, 'other', spec.lang)).not.toBe(key(0))
    expect(specSlideKey(spec.slides[0]!, spec.packId, 'de')).not.toBe(key(0))
  })

  it('takes a kept slide as it is: its content, drawing and notes are not given again', () => {
    const spec = exampleDeckSpec()
    const deck: BuildDeckSlide[] = [
      { id: 'd3', specKey: specSlideKey(spec.slides[3]!, spec.packId, spec.lang), objects: [] },
    ]
    const out = planBuild({ spec, pack, tokens: tokens(), slides: deck })
    const kept = out.slides[3]!
    expect(kept).toMatchObject({ slideId: 'd3', kept: true })
    expect(kept.plan.add.some((o) => o.slot === 'drawn-1')).toBe(false)
  })

  it('names the slides made by hand: a build keeps only its own', () => {
    // The fixture deck's slides are made by hand; s3 holds nothing.
    const h = harness()
    const deck = listSlides(h.deck).map((s) => ({
      id: s.id,
      objects: getSlideObjectsCtx(h.deck, s.id)!.objects.toArray(),
    }))
    const spec: DeckSpec = { ...exampleDeckSpec(), slides: exampleDeckSpec().slides.slice(0, 2) }
    const out = planBuild({ spec, pack, tokens: tokens(), slides: deck })
    expect(out.handMade).toEqual(['s1', 's2'])
    // An empty slide takes the first spec slide.
    expect(out.slides.map((s) => s.slideId)).toEqual(['s3', undefined])
  })

  it('refuses a spec that does not build, naming every problem', () => {
    const spec: DeckSpec = {
      ...exampleDeckSpec(),
      packId: 'other',
      slides: [{ layout: 'nope' }],
    }
    let error: CommandError | undefined
    try {
      planBuild({ spec, pack, tokens: tokens(), slides: [] })
    } catch (e) {
      error = e as CommandError
    }
    expect(error?.code).toBe('invalid_input')
    expect(error?.message).toContain('packId:')
    expect(error?.message).toContain('slides.0.layout:')
  })
})
