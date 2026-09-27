import { Checks, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const A_TITLES = ['Alpha intro', 'Alpha plan', 'Alpha close']
const B_TITLES = ['Beta 1', 'Beta 2', 'Beta 3', 'Beta 4']

export default defineScenario({
  id: 'insert-slides-from-deck',
  title: 'Insert slides 2-3 of deck B after slide 1 of deck A',
  covers: ['deck.insertFrom'],
  maxTurns: 10,
  replay: {
    reason:
      'deck.insertFrom copies between stored decks on the server (media, token rebinding); the memory world does not model it',
  },
  async setup(world) {
    const a = await buildDeck(
      world,
      `Main deck ${world.tag}`,
      A_TITLES.map((t) => titledSlide(t, `${t} details`)),
      world.evalFolderId,
    )
    const b = await buildDeck(
      world,
      `Appendix ${world.tag}`,
      B_TITLES.map((t) => titledSlide(t, `${t} details`)),
      world.evalFolderId,
    )
    return { a: { deckId: a.deckId, title: a.title }, b: { deckId: b.deckId, title: b.title } }
  },
  steps: (fx) => [
    `Insert slides 2–3 of the Narrative deck ${deckRef(fx.b)} into the deck ${deckRef(fx.a)}, right after its first slide.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const a = await readDeck(world, fx.a.deckId)
    c.eq(
      'deck A reads: A1, B2, B3, A2, A3',
      a.slides.map((s) => s.title),
      ['Alpha intro', 'Beta 2', 'Beta 3', 'Alpha plan', 'Alpha close'],
    )
    const b = await readDeck(world, fx.b.deckId)
    c.eq(
      'deck B is unchanged',
      b.slides.map((s) => s.title),
      B_TITLES,
    )
    return c.done()
  },
})
