import { Checks, commandsUsed, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Intro', 'Appendix', 'Results', 'Q&A']

export default defineScenario({
  id: 'slides-outline-nest',
  title: 'Move a slide to the end as a sub-slide of the last one',
  covers: ['slide.move'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Review ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t} details`)),
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, move the slide "Appendix" to the end of the deck and make it a ` +
      'sub-slide (one outline level deeper) of "Q&A".',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const outline = await readDeck(world, fx.deckId)
    c.eq(
      'the deck reads: Intro, Results, Q&A, Appendix',
      outline.slides.map((s) => s.title),
      ['Intro', 'Results', 'Q&A', 'Appendix'],
    )
    c.eq(
      'only Appendix is indented, one level under Q&A',
      outline.slides.map((s) => (s as { indent?: number }).indent ?? 0),
      [0, 0, 0, 1],
    )
    c.eq(
      'the slides kept their ids (moved, not rebuilt)',
      [...outline.slides.map((s) => s.id)].sort(),
      [...fx.slideIds].sort(),
    )
    c.ok('used slide_move', commandsUsed(transcript).includes('slide.move'))
    return c.done()
  },
})
