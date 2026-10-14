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
  readDeckSpec,
  setSlideLayout,
} from '@narrative/slide-model'
import { exampleStylePack, richExampleStylePack, type StylePack } from '@narrative/shared'
import { withCompiledPack } from '../testing/fixtureTokens.js'
import { harness } from '../testing/harness.js'
import { CommandError } from '../errors.js'

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
    // …with the archetype the pack's archetypeMap gives the layout.
    expect(listSlides(h.ctx.deck!).find((s) => s.id === 's2')?.layout).toEqual({
      packId: 'example',
      layoutId: 'title-bullets',
      archetype: 'content',
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
    const out = h.run('slide.applyLayout', { slide: 's2', layoutId: 'picture' }) as {
      unplaced: string[]
    }
    const after = objectsOn(h, 's2')
    // The picture layout has no place for a title or a subtitle: they stay
    // where they were, listed, as PowerPoint keeps the text of a placeholder
    // the new layout lacks; its picture slot holds a placeholder until a
    // picture is given.
    expect(after.find((o) => o.slot === 'picture')?.type).toBe('rectangle')
    expect(after.find((o) => o.id === titleId)?.text).toBe('Hello')
    expect(out.unplaced).toContain(titleId)
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

describe('slide.applyLayout — by archetype, and content by role (A5.1)', () => {
  type Out = { layoutId: string; unplaced: string[] }

  it('takes the layout the pack maps to an archetype, and records the archetype', () => {
    const h = harness()
    const out = h.run('slide.applyLayout', {
      slide: 's2',
      archetype: 'cover',
      content: { title: 'Q3 review' },
    }) as Out
    expect(out.layoutId).toBe('title')
    expect(listSlides(h.ctx.deck!).find((s) => s.id === 's2')?.layout).toMatchObject({
      layoutId: 'title',
      archetype: 'cover',
    })
  })

  it("prefers the archetype's first layout whose required slots the content fills", () => {
    const h = harness()
    const pack = structuredClone(h.ctx.stylePack!) as StylePack
    // Picture first: it requires a picture, which this content does not give.
    pack.archetypeMap = { ...pack.archetypeMap, content: ['picture', 'title-bullets'] }
    h.ctx.stylePack = pack
    const filled = h.run('slide.applyLayout', {
      slide: 's2',
      archetype: 'content',
      content: { title: 'A', bullets: 'B' },
    }) as Out
    expect(filled.layoutId).toBe('title-bullets')
    // Without content the preferred one.
    const bare = h.run('slide.applyLayout', { slide: 's3', archetype: 'content' }) as Out
    expect(bare.layoutId).toBe('picture')
  })

  it('refuses an archetype the pack maps no layout to, and needs exactly one of layoutId / archetype', () => {
    const h = harness()
    const e = h.fail('slide.applyLayout', { slide: 's2', archetype: 'agenda' })
    expect(e.code).toBe('not_found')
    expect(e.message).toContain('cover, content, picture')
    expect(h.fail('slide.applyLayout', { slide: 's2' }).code).toBe('invalid_input')
    expect(
      h.fail('slide.applyLayout', { slide: 's2', layoutId: 'title', archetype: 'cover' }).code,
    ).toBe('invalid_input')
  })

  it('lays out a plain slide by role: text into a component, what has no role stays, listed', () => {
    const h = harness()
    // s2 holds a heading (hd1), a locked logo rectangle and a table, none laid out.
    h.run('object.update', { slide: 's2', object: 'hd1', patch: { role: 'title' } })
    const out = h.run('slide.applyLayout', { slide: 's2', layoutId: 'title-bullets' }) as Out
    const after = objectsOn(h, 's2')
    // The heading's text is now the headline component's (it was dropped before A5.1).
    expect(after.find((o) => o.slot === 'title')?.text).toBe('Results')
    expect(after.some((o) => o.id === 'hd1')).toBe(false)
    expect(out.unplaced).toEqual(expect.arrayContaining(['lock1', 'tbl2']))
    expect(out.unplaced).not.toContain('hd1')
    expect(after.some((o) => o.id === 'lock1')).toBe(true)
  })

  it('pairs regions and objects of one role in reading order, not document order', () => {
    const h = harness()
    const pack = structuredClone(h.ctx.stylePack!) as StylePack
    const column = (slot: string, x: number) => ({
      slot,
      role: 'body' as const,
      type: 'text' as const,
      rect: [x, 0.3, 0.4, 0.5] as [number, number, number, number],
      textStyle: 'body',
    })
    // The right column listed first.
    pack.layouts.push({
      id: 'two-columns',
      name: 'Two columns',
      family: 'content',
      purpose: 'Two columns of text.',
      regions: [column('right', 0.5), column('left', 0.0625)],
    })
    h.ctx.stylePack = pack
    // The right-hand text made first.
    for (const [text, x] of [
      ['Right', 1100],
      ['Left', 100],
    ] as const)
      h.run('object.create', {
        slide: 's3',
        object: { type: 'text', x, y: 400, text, role: 'body' },
      })
    h.run('slide.applyLayout', { slide: 's3', layoutId: 'two-columns' })
    const after = objectsOn(h, 's3')
    expect(after.find((o) => o.slot === 'left')?.text).toBe('Left')
    expect(after.find((o) => o.slot === 'right')?.text).toBe('Right')
  })

  it('keeps the side of a picture the content or the region asks for in view', () => {
    const h = harness()
    const pack = structuredClone(h.ctx.stylePack!) as StylePack
    pack.layouts.find((l) => l.id === 'picture')!.regions[0]!.focus = 'left'
    h.ctx.stylePack = pack
    const picture = (slide: string) => objectsOn(h, slide).find((o) => o.slot === 'picture')!.plain
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'picture',
      content: { picture: { assetId: 'asset-1', focus: 'top' } },
    })
    expect(picture('s2')).toMatchObject({ type: 'image', fit: 'cover', focus: 'top' })
    h.run('slide.applyLayout', {
      slide: 's3',
      layoutId: 'picture',
      content: { picture: { assetId: 'asset-1' } },
    })
    expect(picture('s3')['focus']).toBe('left')
    // 'center' is the default: no focus at all.
    h.run('slide.applyLayout', {
      slide: 's3',
      layoutId: 'picture',
      content: { picture: { assetId: 'asset-1', focus: 'center' } },
    })
    expect(picture('s3')).not.toHaveProperty('focus')
  })

  it("replaces the earlier layout's object of a role with the content given for it", () => {
    const h = harness()
    h.run('slide.applyLayout', { slide: 's2', layoutId: 'picture', content: { statement: 'Old' } })
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title-bullets',
      content: { bullets: 'New bullets' },
    })
    const texts = objectsOn(h, 's2').map((o) => o.text)
    expect(texts).toContain('New bullets')
    // The statement (role body) was replaced, not left beside the bullets.
    expect(texts).not.toContain('Old')
  })

  it("drops a component part still showing its master's text when the layout changes", () => {
    const h = harness()
    // The headline component unfilled: its part reads its master's text.
    h.run('slide.applyLayout', { slide: 's3', layoutId: 'title-bullets' })
    const out = h.run('slide.applyLayout', { slide: 's3', layoutId: 'picture' }) as Out
    const after = objectsOn(h, 's3')
    expect(after.some((o) => o.slot === 'title')).toBe(false)
    expect(out.unplaced.every((id) => after.find((o) => o.id === id)?.slot === undefined)).toBe(
      true,
    )
  })

  it('refuses content for a slot the layout lacks, or of a kind the slot does not take', () => {
    const h = harness()
    const nope = h.fail('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title',
      content: { headline: 'x' },
    })
    expect(nope.code).toBe('invalid_input')
    expect(nope.message).toContain('title, subtitle')
    expect(
      h.fail('slide.applyLayout', {
        slide: 's2',
        layoutId: 'picture',
        content: { picture: 'a caption' },
      }).message,
    ).toContain('takes a picture')
    expect(
      h.fail('slide.applyLayout', {
        slide: 's2',
        layoutId: 'title',
        content: { title: { assetId: 'asset-fixture' } },
      }).message,
    ).toContain('not a picture')
  })

  it('keeps a crop and focus someone chose when the slide is re-laid on the same layout', async () => {
    const h = harness()
    h.run('slide.applyLayout', {
      slide: 's3',
      layoutId: 'picture',
      content: { picture: { assetId: 'asset-fixture' } },
    })
    const pic = objectsOn(h, 's3').find((o) => o.slot === 'picture')!
    const crop = { x: -100, y: 0, width: 2200, height: 1240 }
    h.run('object.update', {
      slide: 's3',
      object: pic.id,
      patch: { imageRect: crop, focus: 'top' },
    })
    await h.runAsync('style.deck.apply', { variant: { background: 'dark' } })
    const after = objectsOn(h, 's3').find((o) => o.id === pic.id)!
    expect(after.plain).toMatchObject({ imageRect: crop, focus: 'top' })
  })

  it('moves a picture into a picture region in place, and never text into it', () => {
    const h = harness()
    h.run('ops.apply', {
      ops: [
        {
          command: 'object.update',
          input: { slide: 's1', object: 'img1', patch: { role: 'picture' } },
        },
        {
          command: 'object.update',
          input: { slide: 's1', object: 't1', patch: { role: 'picture' } },
        },
      ],
    })
    const out = h.run('slide.applyLayout', { slide: 's1', layoutId: 'picture' }) as Out
    const img = objectsOn(h, 's1').find((o) => o.id === 'img1')!
    // Same id (its animations stay), the region's frame, covering it, the old crop gone.
    expect(img.plain).toMatchObject({
      slot: 'picture',
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      fit: 'cover',
    })
    expect(img.plain['imageRect']).toBeUndefined()
    expect(out.unplaced).toContain('t1')
  })
})

describe('style.deck.apply', () => {
  it('sets the variant and fields, re-lays laid-out slides in place, adds the grid', async () => {
    const h = harness()
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title-bullets',
      content: { bullets: 'A' },
    })
    const before = objectsOn(h, 's2').find((o) => o.slot === 'bullets')!.id
    const guidesBefore = listDeckGuides(getDeckGuidesCtx(h.ctx.deck!.doc)).length
    const out = (await h.runAsync('style.deck.apply', {
      variant: { background: 'dark' },
      fields: { client: 'Acme' },
    })) as { slides: number; unmatched: string[]; guidesAdded: number }
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
    const again = (await h.runAsync('style.deck.apply', {})) as { guidesAdded: number }
    expect(again.guidesAdded).toBe(0)
    expect(listDeckGuides(getDeckGuidesCtx(h.ctx.deck!.doc)).length).toBe(
      guidesBefore + out.guidesAdded,
    )
  })

  it("re-lays a slide whose surface the layout no longer offers on its default; leaves another pack's alone", async () => {
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
    const out = (await h.runAsync('style.deck.apply', {})) as {
      slides: number
      unmatched: string[]
      surfaceReset: string[]
    }
    expect(out).toMatchObject({ slides: 1, unmatched: ['s2'], surfaceReset: ['s1'] })
    expect(listSlides(deck).find((s) => s.id === 's1')?.layout).toMatchObject({
      surface: 'picture-dark',
    })
  })

  it('refuses a variant the pack does not have', async () => {
    const h = harness()
    expect((await h.failAsync('style.deck.apply', { variant: { background: 'pink' } })).code).toBe(
      'invalid_input',
    )
    expect((await h.failAsync('style.deck.apply', { variant: { mood: 'dark' } })).code).toBe(
      'invalid_input',
    )
  })
})

describe('style.deck.apply { spec } — the build (A5.3)', () => {
  type Built = {
    slides: number
    built: {
      slides: Array<{
        slide: string
        index: number
        layoutId: string
        archetype?: string
        emptySlots: string[]
      }>
      removed: Array<{ slide: string; title?: string }>
      check: { errors: number; warnings: number }
    }
  }
  const spec = (): Record<string, unknown> => ({
    schemaVersion: 1,
    packId: 'example',
    fields: { client: 'Acme' },
    slides: [
      { archetype: 'cover', slots: { title: 'Q3 review', subtitle: 'Board meeting' } },
      {
        archetype: 'content',
        message: 'Every region grew',
        claims: [{ kind: 'source-needed', text: 'Asia +15 %' }],
        slots: { title: 'Revenue grew', bullets: 'Europe +12 %\n\nAsia +15 %' },
        notes: 'Start with **Asia**.',
      },
    ],
  })

  it("refuses to drop the deck's hand-made slides unless asked, changing nothing", async () => {
    const h = harness()
    const e = await h.failAsync('style.deck.apply', { spec: spec() })
    expect(e.code).toBe('conflict')
    expect(e.message).toContain('s1, s2')
    expect(e.message).toContain('replace: true')
  })

  it('refuses a spec for a component master, before looking anything up', async () => {
    const h = harness()
    h.ctx.target = { componentId: 'cmp1' }
    const e = await h.failAsync('style.deck.apply', { spec: spec(), replace: true })
    expect(e.message).toContain('build decks only')
  })

  it("builds the deck in the spec's order, with its meta, notes and briefs, in one go", async () => {
    const h = harness()
    const out = await h.runAsync<Built>('style.deck.apply', { spec: spec(), replace: true })
    const slides = listSlides(h.deck)
    expect(slides).toHaveLength(2)
    expect(out.built.slides.map((s) => [s.layoutId, s.archetype])).toEqual([
      ['title', 'cover'],
      ['title-bullets', 'content'],
    ])
    // s1 and s2 were made by hand; s3, empty, took the first spec slide.
    expect(out.built.removed.map((r) => r.slide).sort()).toEqual(['s1', 's2'])
    expect(out.built.removed.find((r) => r.slide === 's2')?.title).toBe('Results')
    expect(slides.map((s) => s.layout?.layoutId)).toEqual(['title', 'title-bullets'])
    expect(readDeckMeta(h.deck.doc)).toEqual({ fields: { client: 'Acme' } })
    expect(readDeckSpec(h.deck.doc)).toEqual(spec())
    const outline = h.run<{ specSlides?: number; spec?: unknown }>('query.deck', {})
    expect(outline.specSlides).toBe(2)
    expect(outline.spec).toBeUndefined()
    expect(h.run<{ spec?: unknown }>('query.deck', { spec: true }).spec).toEqual(spec())
    expect(h.run<{ brief?: unknown }>('query.slide', { slide: { index: 1 } }).brief).toMatchObject({
      message: 'Every region grew',
    })
    expect(slides[1]!.brief).toEqual({
      message: 'Every region grew',
      claims: [{ kind: 'source-needed', text: 'Asia +15 %' }],
    })
    const notes = await h.runAsync<{ markdown: string }>('slide.notes.get', { slide: { index: 1 } })
    expect(notes.markdown).toContain('**Asia**')
    // The footer numbers the slide by its place in the built deck.
    const footer = objectsOn(h, slides[1]!.id).find((o) => o.slot === 'footer')
    expect(footer?.text).toBe('Acme | Page 2')
    expect(out.built.check).toEqual({ errors: expect.any(Number), warnings: expect.any(Number) })
  })

  it('forgets the spec it keeps on spec: null, the slides staying', async () => {
    const h = harness()
    await h.runAsync('style.deck.apply', { spec: spec(), replace: true })
    await h.runAsync('style.deck.apply', { spec: null })
    expect(readDeckSpec(h.deck.doc)).toBeNull()
    expect(listSlides(h.deck)).toHaveLength(2)
  })

  it('builds again: an unchanged spec slide keeps its slide and edits, a changed one is built fresh', async () => {
    const h = harness()
    await h.runAsync('style.deck.apply', { spec: spec(), replace: true })
    const [cover, content] = listSlides(h.deck).map((s) => s.id)
    // Someone edits the cover's subtitle by hand.
    const subtitle = objectsOn(h, cover!).find((o) => o.slot === 'subtitle')!
    h.run('text.set', { target: { slide: cover, object: subtitle.id }, text: 'Board, edited' })
    const next = spec()
    ;(next['slides'] as Array<{ slots: Record<string, unknown> }>)[1]!.slots['bullets'] =
      'Asia +16 %'
    await h.runAsync('style.deck.apply', { spec: next })
    const after = listSlides(h.deck).map((s) => s.id)
    expect(after[0]).toBe(cover)
    expect(objectsOn(h, cover!).find((o) => o.slot === 'subtitle')?.text).toBe('Board, edited')
    // The changed slide is a new one, with nothing of the old left on it.
    expect(after[1]).not.toBe(content)
    expect(objectsOn(h, after[1]!).find((o) => o.slot === 'bullets')?.text).toBe('Asia +16 %')
    expect(after).not.toContain(content)
  })

  it('builds a slide inserted into the spec without the notes or text of the slide it displaced', async () => {
    const h = harness()
    await h.runAsync('style.deck.apply', { spec: spec(), replace: true })
    const next = spec()
    const slides = next['slides'] as Array<Record<string, unknown>>
    slides.splice(1, 0, { archetype: 'content', slots: { title: 'New one', bullets: 'x' } })
    await h.runAsync('style.deck.apply', { spec: next })
    const deck = listSlides(h.deck)
    expect(deck).toHaveLength(3)
    const inserted = deck[1]!
    expect(objectsOn(h, inserted.id).find((o) => o.slot === 'title')?.text).toBe('New one')
    const notes = await h.runAsync<{ markdown: string }>('slide.notes.get', { slide: { index: 1 } })
    expect(notes.markdown).not.toContain('Asia')
    const moved = await h.runAsync<{ markdown: string }>('slide.notes.get', { slide: { index: 2 } })
    expect(moved.markdown).toContain('**Asia**')
  })

  it("refuses pictures the deck's and its folder's media do not have, naming where", async () => {
    const h = harness()
    // The server's media service: the fixture's one picture exists.
    h.ctx.services = {
      media: {
        url: async ({ assetId }: { assetId: string }) => {
          if (assetId !== 'asset-fixture') throw new CommandError('not_found', 'no such asset')
          return { url: 'https://img.test/a.jpg' }
        },
      },
    } as never
    const withPicture = (assetId: string) => ({
      ...spec(),
      slides: [{ layout: 'picture', slots: { picture: { assetId } } }],
    })
    const e = await h.failAsync('style.deck.apply', { spec: withPicture('nope'), replace: true })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toContain("slides.0.slots.picture: no picture 'nope'")
    await h.runAsync('style.deck.apply', { spec: withPicture('asset-fixture'), replace: true })
    expect(objectsOn(h, listSlides(h.deck)[0]!.id).find((o) => o.slot === 'picture')?.type).toBe(
      'image',
    )
  })

  it('refuses a spec that does not build, or one beside variant / fields / lang', async () => {
    const h = harness()
    const bad = { ...spec(), packId: 'other' }
    const e = await h.failAsync('style.deck.apply', { spec: bad, replace: true })
    expect(e.code).toBe('invalid_input')
    expect(e.message).toContain('packId')
    expect(
      (await h.failAsync('style.deck.apply', { spec: spec(), variant: { background: 'dark' } }))
        .code,
    ).toBe('invalid_input')
  })
})

describe("style.deck.apply { relayout } — another pack's slides restyled (A5.4)", () => {
  /** The fixture folder after its pack changed from the rich example to the small one. */
  function restyleHarness() {
    const h = harness()
    const rich = richExampleStylePack()
    h.ctx.folderTokens = withCompiledPack(h.ctx.folderTokens!, rich)
    // A colour only the rich pack's slide uses, which the small pack has no counterpart for.
    h.ctx.folderTokens.colors['p-example-rich-color-teal'] = {
      id: 'p-example-rich-color-teal',
      name: 'Teal',
      value: '#008080',
      origin: { pack: 'example-rich', key: 'color:teal' },
    }
    h.ctx.stylePack = rich
    h.run('slide.applyLayout', {
      slide: 's2',
      layoutId: 'title-bullets',
      content: { title: 'Revenue grew', bullets: 'Europe +12 %' },
    })
    h.run('object.create', {
      slide: 's2',
      id: 'teal1',
      object: {
        type: 'rectangle',
        x: 1500,
        y: 900,
        width: 100,
        height: 50,
        fill: { $token: 'colors.p-example-rich-color-teal' },
      },
    })
    h.run('slide.applyLayout', { slide: 's3', archetype: 'statement', content: { quote: 'Q' } })
    h.ctx.stylePack = exampleStylePack()
    return h
  }
  type Out = { slides: number; unmatched: string[]; restyled?: string[] }
  const tokenRefs = (value: unknown): string[] =>
    JSON.stringify(value).match(/"\$token":"[^"]+"/g) ?? []

  it("leaves another pack's slides alone without relayout, listing them", async () => {
    const h = restyleHarness()
    const out = await h.runAsync<Out>('style.deck.apply', {})
    expect(out.unmatched.sort()).toEqual(['s2', 's3'])
    expect(out.restyled).toBeUndefined()
  })

  it("restyles them by archetype: this pack's layout, content kept, colours by purpose", async () => {
    const h = restyleHarness()
    const out = await h.runAsync<Out>('style.deck.apply', { relayout: 'archetype' })
    // The small pack has no layout for a statement: that slide stays, listed.
    expect(out.restyled).toEqual(['s2'])
    expect(out.unmatched).toEqual(['s3'])
    const s2 = listSlides(h.deck).find((s) => s.id === 's2')!
    expect(s2.layout).toMatchObject({
      packId: 'example',
      layoutId: 'title-bullets',
      archetype: 'content',
    })
    const objects = objectsOn(h, 's2')
    expect(objects.find((o) => o.slot === 'title')?.text).toBe('Revenue grew')
    expect(objects.find((o) => o.slot === 'bullets')?.text).toBe('Europe +12 %')
    // Nothing on it points at the rich pack's tokens any more…
    expect(
      tokenRefs(objects.map((o) => o.plain)).filter((t) => t.includes('example-rich')),
    ).toEqual([])
    // …and a colour the small pack has no counterpart for is the colour it was.
    expect(objects.find((o) => o.id === 'teal1')?.plain['fill']).toBe(0x008080)
  })

  it('restyles only the slides named', async () => {
    const h = restyleHarness()
    const out = await h.runAsync<Out>('style.deck.apply', { relayout: 'archetype', slides: ['s3'] })
    expect(out.restyled).toEqual([])
    expect(out.unmatched.sort()).toEqual(['s2', 's3'])
    expect((await h.failAsync('style.deck.apply', { slides: ['s2'] })).code).toBe('invalid_input')
  })
})
