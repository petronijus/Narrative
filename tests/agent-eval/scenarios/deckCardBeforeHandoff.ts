import { Checks, callsOf } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titledSlide } from './helpers.js'

/**
 * The user is about to send someone to the folder and wants its card on the
 * folder page current right now: `deck.refreshThumbnail` (agentic A3.5),
 * which ordinary edits must not call (the card follows by itself — the
 * negative check is in the edit scenarios' graders).
 */
export default defineScenario({
  id: 'deck-card-before-handoff',
  title: 'Make the folder page show the deck’s current title slide before a hand-off',
  covers: ['deck.refreshThumbnail'],
  maxTurns: 6,
  replay: {
    reason:
      'the card is drawn by the render worker and stored by the server; only the live world draws it',
  },
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Client pitch ${world.tag}`,
      [titledSlide('Client pitch', 'Autumn campaign')],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title }
  },
  steps: (fx) => [
    `I changed the title slide of the Narrative deck ${deckRef(fx)} a moment ago and I'm sending ` +
      'my client the link to its folder in a minute. Make sure the folder page shows the current ' +
      'title slide for this deck.',
  ],
  async grade({ world, fixture: fx, transcript }) {
    const c = new Checks()
    const refreshes = callsOf(transcript, 'deck.refreshThumbnail', { ok: true }).filter(
      (x) => x.input['deckId'] === fx.deckId,
    )
    c.ok('it redrew the deck’s card (deck_refreshThumbnail)', refreshes.length > 0)
    c.ok('once is enough', refreshes.length <= 1, `${refreshes.length} calls`)
    const deck = await world.run<{ thumbnailUrl: string | null }>(
      { deckId: fx.deckId },
      'deck.get',
      {},
    )
    c.ok(
      'the deck has a card now',
      typeof deck.thumbnailUrl === 'string' && deck.thumbnailUrl !== '',
    )
    return c.done()
  },
})
