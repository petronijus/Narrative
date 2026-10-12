import { Checks, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { checkOf, packDeck } from './packHelpers.js'

/** Run the brand check and fix what it reports. */
export default defineScenario({
  id: 'pack-fix-check',
  title: 'Fix what the brand check reports on a laid-out slide',
  covers: ['query.check'],
  maxTurns: 14,
  replay: {
    reason: 'not recorded yet: record it with `just eval --filter pack- --record`, then set true',
  },
  async setup(world) {
    const fx = await packDeck(world, 'Pack fix')
    await world.run({ deckId: fx.deckId }, 'style.deck.apply', { fields: { client: 'Acme' } })
    await world.run({ deckId: fx.deckId }, 'slide.applyLayout', {
      slide: { index: 0 },
      layoutId: 'title-bullets',
      content: {
        title: 'Our results.',
        bullets: {
          paragraphs: [
            { runs: [{ text: 'Revenue up', color: '#00ff00' }] },
            { text: 'Costs down' },
          ],
        },
      },
    })
    return fx
  },
  steps: (fx) => [
    `Run the brand check on the Narrative deck ${deckRef(fx)} and fix every error and warning it reports, keeping the slide's message.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const check = await checkOf(world, fx.deckId)
    c.eq(
      'the brand check is clean',
      check.findings.map((f) => `${f.level} ${f.rule}: ${f.message}`),
      [],
    )
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.ok(
      'the slide still says revenue is up',
      slide.objects.some(
        (o) => o['slot'] === 'bullets' && JSON.stringify(o).includes('Revenue up'),
      ),
    )
    return c.done()
  },
})
