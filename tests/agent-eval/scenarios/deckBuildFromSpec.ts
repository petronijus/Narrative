import { exampleDeckSpec } from '../../../packages/commands/src/index.js'
import { Checks, norm, plainText, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { richPackDeck } from './packHelpers.js'

/** Build a whole deck from a deck spec the user hands over (A5.3). */
export default defineScenario({
  id: 'deck-build-from-spec',
  title: 'Build a deck exactly as a given deck spec says',
  covers: ['style.deck.apply', 'query.deck'],
  maxTurns: 10,
  replay: {
    reason:
      'live only: the agent checks the built deck with query.check, measured on the render page',
  },
  async setup(world) {
    return richPackDeck(world, 'Spec build')
  },
  steps: (fx) => [
    `Build the Narrative deck ${deckRef(fx)} from this deck spec, exactly as it is:\n\n` +
      '```json\n' +
      JSON.stringify(exampleDeckSpec(), null, 2) +
      '\n```',
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const spec = exampleDeckSpec()
    const deck = await readDeck(world, fx.deckId)
    c.eq('the deck has the spec’s six slides', deck.slideCount, spec.slides.length)
    c.eq(
      'each slide follows the layout its archetype maps to',
      deck.slides.map((s) => s.layout?.layoutId).join(','),
      'title,agenda,title-bullets,two-columns,quote,closer',
    )
    c.eq("the footer's client is Acme", deck.meta.fields?.['client'], 'Acme')
    c.eq('the deck keeps the spec', deck.specSlides, spec.slides.length)
    if (deck.slideCount < 3) return c.done()
    const third = await readSlide(world, { deckId: fx.deckId }, { index: 2 })
    const title = third.objects.find((o) => o['slot'] === 'title')
    c.ok(
      'slide 3 says "Revenue grew in every region"',
      title !== undefined && norm(plainText(title)) === 'Revenue grew in every region',
    )
    c.ok('slide 3 has its notes', third.notes.includes('Asia'))
    const brief = (third as unknown as { brief?: { claims?: Array<{ source?: string }> } }).brief
    c.eq('slide 3 keeps its sourced claim', brief?.claims?.[0]?.source, 'Q3 finance report')
    return c.done()
  },
})
