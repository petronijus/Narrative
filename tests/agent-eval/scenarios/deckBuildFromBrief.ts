import { Checks, callsOf, norm, readDeck } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { checkErrors, richPackDeck } from './packHelpers.js'

/**
 * A whole deck from a brief (A5.7 build-deck): the agent plans first and
 * writes nothing, then builds once the user answers and approves.
 */
export default defineScenario({
  id: 'deck-build-from-brief',
  title: 'Plan a deck from a brief with the user, then build it with the brand',
  covers: ['style.pack.get', 'style.deck.apply', 'query.check', 'query.render'],
  maxTurns: 60,
  stepTimeoutMs: 15 * 60_000,
  replay: {
    reason: 'live only: the agent looks at the slides with query.render and checks them measured',
  },
  async setup(world) {
    return richPackDeck(world, 'Brief build')
  },
  steps: (fx) => [
    `Build a deck in the Narrative deck ${deckRef(fx)}: Acme's quarterly review for its board. ` +
      'Revenue grew in every region in Q3 (Europe +12 %, Americas +8 %, Asia +15 %; source: Q3 finance ' +
      'report); Asia grew fastest on new customers. The board must decide whether to double the Asia ' +
      'budget. Plan it with me before you build anything.',
    'The board is five people, they read the deck before the meeting. Plain, confident tone, in our ' +
      'own voice (we are Acme). About 10 slides, the light variant, the client field "Acme", English. ' +
      'Take the direction you recommend and build it — no need to show me the table again.',
  ],
  async afterStep(world, fx, index, notes) {
    // Nothing is written while the deck is still being planned.
    if (index === 0) notes['slidesAfterPlanning'] = (await readDeck(world, fx.deckId)).slideCount
  },
  async grade({ world, fixture: fx, transcript, notes }) {
    const c = new Checks()
    c.eq('nothing was built while planning', notes['slidesAfterPlanning'], 1)
    const deck = await readDeck(world, fx.deckId)
    c.ok(`8–14 slides (${deck.slideCount})`, deck.slideCount >= 8 && deck.slideCount <= 14)
    c.ok(
      'every slide follows a layout of the pack',
      deck.slides.every((s) => s.layout !== undefined),
    )
    const titles = deck.slides.map((s) => norm(s.title ?? ''))
    c.eq('every title is different', new Set(titles).size, titles.length)
    const perLayout = new Map<string, number>()
    for (const s of deck.slides)
      perLayout.set(s.layout?.layoutId ?? '', (perLayout.get(s.layout?.layoutId ?? '') ?? 0) + 1)
    c.ok(
      'no layout on more than half the slides',
      [...perLayout.values()].every((n) => n * 2 <= deck.slideCount),
    )
    c.eq('the brand check finds no errors', await checkErrors(world, fx.deckId), [])
    c.ok(
      'it built the deck from a spec',
      callsOf(transcript, 'style.deck.apply', { ok: true }).length > 0,
    )
    c.ok('it looked at the slides', callsOf(transcript, 'query.render', { ok: true }).length > 0)
    return c.done()
  },
})
