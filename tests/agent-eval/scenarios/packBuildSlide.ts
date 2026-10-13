import { Checks, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { checkOf, packDeck } from './packHelpers.js'

/** Build a slide of a given purpose with the folder's style pack, and pass the brand check. */
export default defineScenario({
  id: 'pack-build-slide',
  title: "Build a content slide with the folder's style pack and pass the brand check",
  covers: ['style.pack.get', 'slide.applyLayout', 'style.deck.apply', 'query.check'],
  maxTurns: 14,
  replay: {
    reason:
      'live only: the agent measures the text with query.check, and the memory world has no renderer',
  },
  async setup(world) {
    return packDeck(world, 'Pack build')
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, build a content slide with the deck's style pack: ` +
      'the headline "Revenue grew in every region" and three bullets — "Europe +12 %", "Americas +8 %", ' +
      '"Asia +15 %". The client is Acme. The deck must pass the brand check.',
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const layout = (slide as unknown as { layout?: { packId: string; layoutId: string } }).layout
    c.eq('the slide follows the title-and-bullets layout', layout?.layoutId, 'title-bullets')
    const bySlot = (slot: string) => slide.objects.find((o) => o['slot'] === slot)
    const title = bySlot('title')
    c.ok(
      'the title slot holds the headline',
      title !== undefined && /revenue grew in every region/i.test(norm(plainText(title))),
    )
    const bullets = bySlot('bullets')
    const text = bullets === undefined ? '' : plainText(bullets)
    c.ok(
      'the bullets slot holds the three regions',
      ['Europe', 'Americas', 'Asia'].every((r) => text.includes(r)),
    )
    const meta = await world.run<{ fields?: Record<string, string> }>(
      { deckId: fx.deckId },
      'query.deck',
      {},
    )
    void meta
    const check = await checkOf(world, fx.deckId)
    c.eq(
      'the brand check finds no errors',
      check.findings.filter((f) => f.level === 'error').map((f) => `${f.rule}: ${f.message}`),
      [],
    )
    return c.done()
  },
})
