import { exampleStylePack } from '@narrative/shared'
import { Checks, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { checkOf, packDeck, richPackDeck } from './packHelpers.js'

/**
 * Another brand's deck inserted and restyled (A5.4/A5.5, insert-restyle):
 * deck B (the rich pack's folder) after slide 4 of deck A (the small
 * pack's), made to look like A; B itself untouched.
 */
export default defineScenario({
  id: 'insert-restyle-pack',
  title: "Insert another brand's slides and make them look like ours",
  covers: ['deck.insertFrom', 'style.deck.apply', 'slide.applyLayout', 'query.check'],
  maxTurns: 40,
  replay: { reason: 'live only: deck.insertFrom across folders, and the agent renders the slides' },
  async setup(world) {
    const a = await packDeck(world, 'Restyle A', 5, exampleStylePack())
    for (const [i, layoutId] of [
      'title',
      'title-bullets',
      'title-bullets',
      'picture',
      'title-bullets',
    ].entries())
      await world.run({ deckId: a.deckId }, 'slide.applyLayout', {
        slide: { index: i },
        layoutId,
        content: layoutId === 'picture' ? {} : { title: `Our slide ${i + 1}` },
      })
    await world.run({ deckId: a.deckId }, 'style.deck.apply', { fields: { client: 'Acme' } })
    const b = await richPackDeck(world, 'Restyle B')
    await world.run({ deckId: b.deckId }, 'style.deck.apply', {
      spec: {
        schemaVersion: 1,
        packId: 'example-rich',
        fields: { client: 'Partner' },
        slides: [
          { archetype: 'content', slots: { title: 'Their numbers', bullets: 'Growth +9 %' } },
          { archetype: 'statement', slots: { quote: 'Partners grow faster together.' } },
          { archetype: 'content', slots: { title: 'Their plan', bullets: 'Expand in Asia' } },
        ],
      },
    })
    return { deckId: a.deckId, title: a.title, sourceDeckId: b.deckId, sourceTitle: b.title }
  },
  steps: (fx) => [
    `Insert all slides of the Narrative deck "${fx.sourceTitle}" (id ${fx.sourceDeckId}) after slide 4 ` +
      `of ${deckRef(fx)}, and make them look like the rest of that deck.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const deck = await readDeck(world, fx.deckId)
    c.eq('the deck has its 5 slides and the 3 inserted', deck.slideCount, 8)
    const inserted = deck.slides.slice(4, 7)
    c.ok(
      "the inserted slides follow this deck's pack",
      inserted.every((s) => s.layout?.packId === 'example'),
    )
    c.ok(
      'their text came along',
      inserted.some((s) => /their numbers/i.test(s.title ?? '')) &&
        inserted.some((s) => /their plan/i.test(s.title ?? '')),
    )
    // On the inserted slides: deck A's own picture slide waits for its picture.
    const insertedIds = new Set(inserted.map((s) => s.id))
    const check = await checkOf(world, fx.deckId)
    c.eq(
      'the brand check finds no errors on the inserted slides',
      check.findings
        .filter((f) => f.level === 'error' && f.rule !== 'font-missing')
        .filter((f) => f.slideId !== undefined && insertedIds.has(f.slideId))
        .map((f) => `${f.rule}: ${f.message}`),
      [],
    )
    const source = await readDeck(world, fx.sourceDeckId)
    c.ok(
      'deck B is untouched',
      source.slideCount === 3 && source.slides.every((s) => s.layout?.packId === 'example-rich'),
    )
    return c.done()
  },
})
