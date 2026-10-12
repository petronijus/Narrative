import { Checks, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { packDeck } from './packHelpers.js'

/** Switch a laid-out deck to the pack's dark variant, keeping every slot's content. */
export default defineScenario({
  id: 'pack-deck-variant',
  title: "Switch a deck to its style pack's dark variant without losing content",
  covers: ['style.deck.apply'],
  maxTurns: 8,
  replay: {
    reason: 'not recorded yet: record it with `just eval --filter pack- --record`, then set true',
  },
  async setup(world) {
    const fx = await packDeck(world, 'Pack variant', 2)
    await world.run({ deckId: fx.deckId }, 'slide.applyLayout', {
      slide: { index: 0 },
      layoutId: 'title',
      content: { title: 'Annual review', subtitle: 'Board meeting' },
    })
    await world.run({ deckId: fx.deckId }, 'slide.applyLayout', {
      slide: { index: 1 },
      layoutId: 'title-bullets',
      content: { title: 'Highlights', bullets: 'Record year' },
    })
    return fx
  },
  steps: (fx) => [`Switch the Narrative deck ${deckRef(fx)} to the dark version of its brand.`],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const deck = await world.run<{ slides: Array<{ background?: { color?: number } }> }>(
      { deckId: fx.deckId },
      'query.deck',
      {},
    )
    void deck
    for (const [i, slot, text] of [
      [0, 'title', 'Annual review'],
      [1, 'bullets', 'Record year'],
    ] as const) {
      const slide = await readSlide(world, { deckId: fx.deckId }, { index: i })
      const obj = slide.objects.find((o) => o['slot'] === slot)
      c.ok(
        `slide ${i + 1} keeps its ${slot}`,
        obj !== undefined && norm(plainText(obj)).includes(norm(text)),
      )
      const bg = (slide as unknown as { background?: { color?: number } }).background
      c.eq(`slide ${i + 1} is on the dark background (navy)`, bg?.color, 0x001e50)
    }
    return c.done()
  },
})
