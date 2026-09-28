import { Checks, commandsUsed, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

const TITLES = ['Intro', 'Problem', 'Solution', 'Team']

export default defineScenario({
  id: 'slides-copy-block',
  title: 'Copy slides 2–3 to the end of the same deck',
  covers: ['slide.copyTo'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Pitch ${world.tag}`,
      TITLES.map((t) => titledSlide(t, `${t} details`)),
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, copy slides 2 and 3 to the end of the deck, keeping their order.`,
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const outline = await readDeck(world, fx.deckId)
    c.eq(
      'the deck reads: Intro, Problem, Solution, Team, Problem, Solution',
      outline.slides.map((s) => s.title),
      [...TITLES, 'Problem', 'Solution'],
    )
    if (outline.slideCount !== 6) return c.done()
    c.eq(
      'the originals keep their ids and places',
      outline.slides.slice(0, 4).map((s) => s.id),
      fx.slideIds,
    )
    for (const [copyIndex, sourceIndex] of [
      [4, 1],
      [5, 2],
    ] as const) {
      const copy = await readSlide(world, { deckId: fx.deckId }, { index: copyIndex })
      const source = await readSlide(world, { deckId: fx.deckId }, { index: sourceIndex })
      c.eq(
        `slide ${copyIndex + 1} is a whole copy of slide ${sourceIndex + 1}`,
        copy.objects.map((o) => [o.id, o.text]),
        source.objects.map((o) => [o.id, o.text]),
      )
    }
    c.ok('used slide_copyTo', commandsUsed(transcript).includes('slide.copyTo'))
    return c.done()
  },
})
