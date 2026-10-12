/**
 * check.test.ts — the brand checker (A4.5) on the fixture deck laid out with
 * the example pack: a clean laid-out slide passes; each rule fires on the
 * break it is for; the pack's levels and `off` apply; a measurement with a
 * failed font, or without growing boxes, leaves the fit unverified.
 */

import { describe, expect, it } from 'vitest'
import { listSlides, readDeckMeta, updateObject } from '@narrative/slide-model'
import type { StylePack } from '@narrative/shared'
import { harness } from '../testing/harness.js'
import { objectsOf, resolveSlide } from '../refs.js'
import { checkDeck, type CheckMeasurement } from './check.js'

const NONE: CheckMeasurement = { overflow: [], grown: [], failedFonts: [] }

function laidOut(content: Record<string, unknown> = {}) {
  const h = harness()
  h.run('style.deck.apply', { fields: { client: 'Acme' } })
  h.run('slide.applyLayout', {
    slide: 's2',
    layoutId: 'title-bullets',
    content: { title: 'Revenue grew', bullets: 'Europe', ...content },
  })
  // The fixture's own objects on s2 are not the pack's: leave them out.
  const slide = resolveSlide(h.ctx.deck!, { id: 's2' })
  const objects = objectsOf(h.ctx.deck!, slide)
  for (const m of objects.objects.toArray())
    if (m.get('slot') === undefined) objects.objects.delete(objects.objects.toArray().indexOf(m), 1)
  return h
}

function check(
  h: ReturnType<typeof harness>,
  opts: { pack?: StylePack; measurement?: CheckMeasurement | null } = {},
) {
  const slides = listSlides(h.ctx.deck!)
  return checkDeck({
    pack: opts.pack ?? h.ctx.stylePack!,
    tokens: h.ctx.folderTokens ?? null,
    meta: readDeckMeta(h.ctx.deck!.doc),
    slides: slides.map((slide, index) => ({ slide, index })).filter((s) => s.slide.id === 's2'),
    measurement: opts.measurement === undefined ? NONE : opts.measurement,
  })
}

const slotId = (h: ReturnType<typeof harness>, slot: string) =>
  listSlides(h.ctx.deck!)
    .find((s) => s.id === 's2')!
    .objects.find((o) => o.slot === slot)!.id

function edit(h: ReturnType<typeof harness>, id: string, patch: Record<string, unknown>) {
  const slide = resolveSlide(h.ctx.deck!, { id: 's2' })
  updateObject(objectsOf(h.ctx.deck!, slide), id, patch as never)
}

describe('checkDeck', () => {
  it('passes a slide laid out with the pack', () => {
    const r = check(laidOut())
    expect(r.findings).toEqual([])
    expect(r.fitVerified).toBe(true)
  })

  it('flags overflow, and a growing box that runs into the footer', () => {
    const h = laidOut()
    const bullets = slotId(h, 'bullets')
    const title = slotId(h, 'title')
    edit(h, title, { autofit: 'grow-down' })
    const r = check(h, {
      measurement: {
        overflow: [{ slideId: 's2', objectId: bullets, boxHeight: 600, textHeight: 700 }],
        grown: [{ slideId: 's2', objectId: title, height: 400 }],
        failedFonts: [],
      },
    })
    expect(r.findings.map((f) => f.rule)).toEqual(['fit', 'fit'])
    expect(r.findings.find((f) => f.objectId === bullets)!.message).toContain('100 px below')
    expect(r.findings.find((f) => f.objectId === title)!.message).toContain('over bullets')
  })

  it('leaves the fit unverified when a font failed or growing boxes were not measured', () => {
    const h = laidOut()
    edit(h, slotId(h, 'title'), { autofit: 'grow-down' })
    const failed = check(h, { measurement: { ...NONE, failedFonts: ['Inter'] } })
    expect(failed.fitVerified).toBe(false)
    expect(failed.findings[0]).toMatchObject({ rule: 'font-missing', level: 'error' })
    const old = check(h, { measurement: { ...NONE, grown: null } })
    expect(old.fitVerified).toBe(false)
    expect(old.findings.map((f) => f.rule)).toEqual(['fit'])
    expect(check(h, { measurement: null }).fitVerified).toBe(false)
  })

  it('flags overlap, the grid, colours, editorial rules and placeholders', () => {
    const h = laidOut({
      bullets: {
        paragraphs: [
          { text: 'Grew 10-20 % in the "core" markets...' },
          { runs: [{ text: 'ALL OF THIS IS LOUD', italic: true }] },
          { text: 'A rocket 🚀' },
          { list: 'bullet', bulletChar: '•', text: 'Odd bullet' },
        ],
      },
    })
    const bullets = slotId(h, 'bullets')
    const title = slotId(h, 'title')
    edit(h, title, { y: 250, x: 20, color: 0x00ff00 })
    const rules = check(h).findings.map((f) => f.rule)
    expect(rules).toEqual(
      expect.arrayContaining([
        'partial-overlap',
        'outside-grid',
        'text-color',
        'typography',
        'caps',
        'italics',
        'emoji',
        'bullet-glyph',
      ]),
    )
    // The footer's sentinel: the client field cleared.
    h.run('style.deck.apply', { fields: { client: null } })
    expect(check(h).findings.find((f) => f.rule === 'sentinel')).toMatchObject({
      level: 'error',
      message: expect.stringContaining('"Client"'),
    })
    expect(bullets).toBeDefined()
  })

  it('flags a title period, missing furniture, an empty picture and a variant background', () => {
    const h = laidOut({ title: 'Revenue grew.' })
    edit(h, slotId(h, 'title'), {})
    const slide = resolveSlide(h.ctx.deck!, { id: 's2' })
    const objects = objectsOf(h.ctx.deck!, slide)
    const footerIndex = objects.objects.toArray().findIndex((m) => m.get('slot') === 'footer')
    objects.objects.delete(footerIndex, 1)
    h.run('slide.setBackground', { slide: 's2', background: { kind: 'color', color: '#001e50' } })
    const rules = check(h).findings.map((f) => f.rule)
    expect(rules).toEqual(expect.arrayContaining(['title-period', 'furniture', 'variant-mix']))

    h.run('slide.applyLayout', { slide: 's3', layoutId: 'picture' })
    const s3 = listSlides(h.ctx.deck!)
    const picture = checkDeck({
      pack: h.ctx.stylePack!,
      tokens: h.ctx.folderTokens ?? null,
      meta: readDeckMeta(h.ctx.deck!.doc),
      slides: [{ slide: s3.find((s) => s.id === 's3')!, index: 2 }],
      measurement: null,
    })
    expect(picture.findings.map((f) => f.rule)).toContain('missing-picture')
  })

  it("takes the pack's levels, and skips a rule set off", () => {
    const h = laidOut({ title: 'Revenue grew.' })
    const pack = structuredClone(h.ctx.stylePack!)
    pack.qa.rules = { 'title-period': 'error' }
    expect(check(h, { pack }).findings[0]).toMatchObject({ rule: 'title-period', level: 'error' })
    pack.qa.rules = { 'title-period': 'off' }
    expect(check(h, { pack }).findings).toEqual([])
  })
})
