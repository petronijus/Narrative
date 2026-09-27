import { Checks, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

export default defineScenario({
  id: 'transition-remove-direction',
  title: "Remove a push transition's direction, keep kind and duration",
  covers: ['slide.setTransition'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Roadshow ${world.tag}`,
      [
        titledSlide('Roadshow'),
        {
          ...titledSlide('Stop one: Berlin'),
          transition: { kind: 'push', durationMs: 500, direction: 'left' },
        },
        // A distractor: the next slide's push must keep its direction.
        {
          ...titledSlide('Stop two: Vienna'),
          transition: { kind: 'push', durationMs: 700, direction: 'up' },
        },
      ],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  steps: (fx) => [
    `Slide 2 of the Narrative deck ${deckRef(fx)} has a push transition with a direction. Remove the direction from that transition, but keep it a push transition with the same duration.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const deck = { deckId: fx.deckId }
    const [s1, s2, s3] = await Promise.all(
      [0, 1, 2].map((index) => readSlide(world, deck, { index })),
    )
    c.eq('slide 2: push, 500 ms, no direction', s2!.transition, { kind: 'push', durationMs: 500 })
    c.eq('slide 3 keeps its push up, 700 ms', s3!.transition, {
      kind: 'push',
      durationMs: 700,
      direction: 'up',
    })
    c.eq('slide 1 still has no transition', s1!.transition.kind, 'none')
    return c.done()
  },
})
