import { exampleDeckSpec } from '../../../packages/commands/src/index.js'
import { Checks, norm, plainText, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { richPackDeck } from './packHelpers.js'

/** Build a deck again from the spec it keeps, in another variant (A5.3: the spec is the deck's source). */
export default defineScenario({
  id: 'deck-rebuild-other-variant',
  title: 'Rebuild a deck from its stored spec in the dark variant',
  covers: ['query.deck', 'style.deck.apply'],
  maxTurns: 10,
  replay: {
    reason:
      'live only: the agent checks the built deck with query.check, measured on the render page',
  },
  async setup(world) {
    const fx = await richPackDeck(world, 'Spec rebuild')
    await world.run({ deckId: fx.deckId }, 'style.deck.apply', { spec: exampleDeckSpec() })
    return fx
  },
  steps: (fx) => [
    `The Narrative deck ${deckRef(fx)} was built from a deck spec. Build it again from that spec, ` +
      'but in the dark variant of the brand. Change nothing else.',
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const deck = await readDeck(world, fx.deckId)
    c.eq('the deck is in the dark variant', deck.meta.variant?.['background'], 'dark')
    c.eq('it still has six slides', deck.slideCount, 6)
    const spec = await world.run<{ spec?: { variant?: Record<string, string> } }>(
      { deckId: fx.deckId },
      'query.deck',
      { spec: true },
    )
    c.eq('the spec it keeps says dark', spec.spec?.variant?.['background'], 'dark')
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 2 })
    const title = slide.objects.find((o) => o['slot'] === 'title')
    c.ok(
      'the content is unchanged',
      title !== undefined && norm(plainText(title)) === 'Revenue grew in every region',
    )
    return c.done()
  },
})
