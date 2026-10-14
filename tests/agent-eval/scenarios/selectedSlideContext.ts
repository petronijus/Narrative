import { Checks, callsOf, deckSnapshot, finalText, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox, titledSlide } from './helpers.js'

/**
 * "This" resolution: the user has slide 2 open with one box selected, and
 * asks about it without naming it. Only editor.context knows. The live world
 * opens the deck in a real browser (Playwright) and selects the box, so the
 * awareness state editor.context reads is the one a person's editor
 * publishes; the memory world sets the same state on its fake editor.
 */
export default defineScenario({
  id: 'selected-slide-context',
  title: '"What\'s on the slide I have selected" resolves through editor.context',
  covers: ['editor.context', 'query.slide'],
  maxTurns: 8,
  requires: ['browser'],
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Pricing ${world.tag}`,
      [
        titledSlide('Welcome', 'Thanks for joining.'),
        {
          objects: [
            { key: 'title', object: titleBox('Pricing tiers') },
            { key: 'starter', object: bodyBox('Starter plan: 9 EUR per seat', { width: 780 }) },
            {
              key: 'enterprise',
              object: bodyBox('Enterprise plan: talk to sales', { x: 1000, width: 800 }),
            },
          ],
        },
        titledSlide('Questions?'),
      ],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      activeSlideId: deck.slideIds[1]!,
      selectedId: deck.objects[1]!['enterprise']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await deckSnapshot(world, fx.deckId)
    await world.openEditor(fx.deckId, {
      slideId: fx.activeSlideId,
      selectedObjectIds: [fx.selectedId],
    })
  },
  steps: (fx) => [
    `I have the Narrative deck ${deckRef(fx)} open in my editor with one object selected. What's on the slide I'm looking at, and which object have I selected? Don't change anything.`,
  ],
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    const context = callsOf(transcript, 'editor.context', { ok: true })
    c.ok('asked editor_context what the user is looking at', context.length > 0)
    const seen = context.at(-1)?.result as
      { activeSlideId?: string; selectedObjectIds?: string[] } | undefined
    c.eq(
      'editor_context reported the open slide and selection',
      seen && { slide: seen.activeSlideId, selected: seen.selectedObjectIds },
      {
        slide: fx.activeSlideId,
        selected: [fx.selectedId],
      },
    )
    const answer = finalText(transcript).toLowerCase()
    c.ok(
      'the answer names the slide ("Pricing tiers")',
      answer.includes('pricing tiers'),
      `answer: ${finalText(transcript).slice(0, 400)}`,
    )
    c.ok(
      'the answer names the selected object (the Enterprise plan box)',
      answer.includes('enterprise'),
    )
    const after = await deckSnapshot(world, fx.deckId)
    c.eq('nothing in the deck changed', after, notes['before'] as SlideView[])
    return c.done()
  },
})
