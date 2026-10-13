/**
 * layouts.test.ts — slides laid out with the folder's style pack (A4.4):
 * slide.applyLayout places regions linked to the compiled styles and
 * colours, moves content between layouts by slot and role, regenerates
 * furniture; style.deck.apply sets the variant, re-lays every laid-out
 * slide in place and adds the grid as guides. The fixture folder holds the
 * example pack, compiled (testing/fixtureTokens.ts).
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  getDeckGuidesCtx,
  getSlideObjectsCtx,
  listDeckGuides,
  listSlides,
  readDeckMeta,
  setSlideLayout,
} from '@narrative/slide-model'
import type { StylePack } from '@narrative/shared'
import { harness } from '../testing/harness.js'

function objectsOn(h: ReturnType<typeof harness>, slideId: string) {
  return (getSlideObjectsCtx(h.ctx.deck!, slideId)?.objects.toArray() ?? []).map((m) => ({
    id: m.get('id') as string,
    type: m.get('type') as string,
    slot: m.get('slot') as string | undefined,
    role: m.get('role') as string | undefined,
    text: (m.get('text') as Y.Text | string | undefined)?.toString(),
    plain: m.toJSON() as Record<string, unknown>,
  }))
}

describe('slide.applyLayout', () => {
  it('places the regions linked to the compiled styles, with content and furniture', () => {
    const h = harness()
    const out = h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title-bullets',
      content: { bullets: { paragraphs: [{ text: 'One' }, { text: 'Two' }] } },
    }) as { added: number }
    expect(out.added).toBeGreaterThan(0)
    const objects = objectsOn(h, 's2')
    const bullets = objects.find((o) => o.slot === 'bullets')!
    expect(bullets.plain).toMatchObject({
      role: 'body',
      textStyleId: 'p-example-textStyle-body',
      autofit: 'shrink',
      x: 120,
      y: 300,
    })
    // The style's list levels reach the box; the body's paragraphs are bullets by default.
    expect(bullets.plain['listLevels']).toEqual(
      expect.arrayContaining([expect.objectContaining({ bulletChar: '–', indent: 36 })]),
    )
    expect(bullets.text).toContain('One')
    // The headline component's object at the title region.
    expect(objects.find((o) => o.slot === 'title')?.plain).toMatchObject({ role: 'title', x: 120 })
    // Furniture: footer text with the sentinel (no client yet) and the page number.
    const footer = objects.find((o) => o.slot === 'footer')!
    expect(footer.role).toBe('furniture')
    expect(footer.text).toBe('Client | Page 2')
    expect(objects.find((o) => o.slot === 'pagenum')?.plain['isSlideNumber']).toBe(true)
    // The slide follows the layout; objects people made stay.
    expect(listSlides(h.ctx.deck!).find((s) => s.id === 's2')?.layout).toEqual({
      packId: 'example',
      layoutId: 'title-bullets',
    })
    expect(objects.some((o) => o.slot === undefined)).toBe(true)
  })

  it('moves content into the new layout by role, keeps a slot in place, and pins a surface', () => {
    const h = harness()
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title',
      content: { title: 'Hello', subtitle: 'World' },
    })
    const titleId = objectsOn(h, 's2').find((o) => o.slot === 'title')!.id
    h.run('slide.applyLayout', { slide: 's2', layoutId: 'picture' })
    const after = objectsOn(h, 's2')
    // The picture layout has no title or subtitle slot: those objects go; its
    // picture slot holds a placeholder until a picture is given.
    expect(after.find((o) => o.slot === 'picture')?.type).toBe('rectangle')
    expect(after.some((o) => o.id === titleId)).toBe(false)
    expect(listSlides(h.ctx.deck!).find((s) => s.id === 's2')?.layout?.surface).toBe('picture-dark')
    // Re-applying the same layout updates in place: ids stay.
    const statementId = after.find((o) => o.slot === 'statement')!.id
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'picture',
      content: { statement: 'Look' },
    })
    const again = objectsOn(h, 's2').find((o) => o.slot === 'statement')!
    expect(again.id).toBe(statementId)
    expect(again.text).toBe('Look')
  })

  it('refuses a stored pack that is not valid, naming what is wrong', () => {
    const h = harness()
    const broken = structuredClone(h.ctx.stylePack!) as StylePack
    ;(broken.layouts[0] as unknown as Record<string, unknown>)['surface'] = null
    h.ctx.stylePack = broken
    const e = h.fail('slide.applyLayout', { slide: 's1', layoutId: 'title' })
    expect(e.code).toBe('conflict')
    expect(e.message).toContain('stored style pack is not valid')
    expect(e.message).toContain('layouts.0.surface')
  })

  it('refuses a layout the pack does not have', () => {
    const h = harness()
    const e = h.fail('slide.applyLayout', { slide: 's1', layoutId: 'nope' })
    expect(e.code).toBe('not_found')
    expect(e.message).toContain('title-bullets')
  })
})

describe('style.deck.apply', () => {
  it('sets the variant and fields, re-lays laid-out slides in place, adds the grid', () => {
    const h = harness()
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title-bullets',
      content: { bullets: 'A' },
    })
    const before = objectsOn(h, 's2').find((o) => o.slot === 'bullets')!.id
    const guidesBefore = listDeckGuides(getDeckGuidesCtx(h.ctx.deck!.doc)).length
    const out = h.run('style.deck.apply', {
      variant: { background: 'dark' },
      fields: { client: 'Acme' },
    }) as { slides: number; unmatched: string[]; guidesAdded: number }
    expect(out).toMatchObject({ slides: 1, unmatched: [] })
    expect(out.guidesAdded).toBeGreaterThan(0)
    expect(readDeckMeta(h.ctx.deck!.doc)).toMatchObject({
      variant: { background: 'dark' },
      fields: { client: 'Acme' },
    })
    const objects = objectsOn(h, 's2')
    expect(objects.find((o) => o.slot === 'bullets')!.id).toBe(before)
    expect(objects.find((o) => o.slot === 'footer')!.text).toBe('Acme | Page 2')
    // The background follows the dark variant: navy.
    expect(listSlides(h.ctx.deck!).find((s) => s.id === 's2')?.background).toMatchObject({
      color: 0x001e50,
    })
    // A second run adds no guide twice.
    const again = h.run('style.deck.apply', {}) as { guidesAdded: number }
    expect(again.guidesAdded).toBe(0)
    expect(listDeckGuides(getDeckGuidesCtx(h.ctx.deck!.doc)).length).toBe(
      guidesBefore + out.guidesAdded,
    )
  })

  it("re-lays a slide whose surface the layout no longer offers on its default; leaves another pack's alone", () => {
    const h = harness()
    const pack = structuredClone(h.ctx.stylePack!) as StylePack
    const title = pack.layouts.find((l) => l.id === 'title')!
    title.surface = { default: 'picture-dark', choose: ['picture-dark'] }
    h.ctx.stylePack = pack
    h.run('slide.applyLayout', { slide: 's1', layoutId: 'title' })
    h.run('slide.applyLayout', { slide: 's2', layoutId: 'title' })
    const deck = h.ctx.deck!
    // s1 was on a surface the pack has since dropped; s2 came from another pack.
    setSlideLayout(deck, 's1', { packId: pack.id, layoutId: 'title', surface: 'gone' })
    setSlideLayout(deck, 's2', { packId: 'other', layoutId: 'title' })
    const out = h.run('style.deck.apply', {}) as {
      slides: number
      unmatched: string[]
      surfaceReset: string[]
    }
    expect(out).toMatchObject({ slides: 1, unmatched: ['s2'], surfaceReset: ['s1'] })
    expect(listSlides(deck).find((s) => s.id === 's1')?.layout).toMatchObject({
      surface: 'picture-dark',
    })
  })

  it('refuses a variant the pack does not have', () => {
    const h = harness()
    expect(h.fail('style.deck.apply', { variant: { background: 'pink' } }).code).toBe(
      'invalid_input',
    )
    expect(h.fail('style.deck.apply', { variant: { mood: 'dark' } }).code).toBe('invalid_input')
  })
})
