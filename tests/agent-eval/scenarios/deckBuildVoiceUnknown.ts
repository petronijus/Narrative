import { Checks, finalText, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { richPackDeck } from './packHelpers.js'

/** A deck in a client's voice with no sample of it: ask for one, build nothing yet (A5.7 build-deck). */
export default defineScenario({
  id: 'deck-build-voice-unknown',
  title: "Ask for the client's voice before building a deck in it",
  covers: ['style.pack.get', 'query.deck'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    return richPackDeck(world, 'Voice unknown')
  },
  steps: (fx) => [
    `Build a 10-slide pitch deck in the Narrative deck ${deckRef(fx)} for our client Northwind ` +
      'Logistics: why they should move their fleet planning to our platform. It must sound like ' +
      'Northwind, in their voice.',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const deck = await readDeck(world, fx.deckId)
    c.eq('nothing was built yet', deck.slideCount, 1)
    c.eq('the one slide is still empty', deck.slides[0]?.objectCount, 0)
    const answer = finalText(transcript)
    c.ok(
      "it asks for a sample of Northwind's voice",
      // A question or a plain "I need …": it names the voice and what would show it.
      /\bvoice\b/i.test(answer) &&
        /\b(sample|example|website|copy|guide|wrote|written|describ\w*)\b/i.test(answer),
    )
    return c.done()
  },
})
