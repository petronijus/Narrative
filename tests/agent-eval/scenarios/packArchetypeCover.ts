import { Checks, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { deckRef } from './helpers.js'
import { packDeck } from './packHelpers.js'

/** Make a slide the deck's cover with the pack's layout for that kind of slide (A5.1 archetypes). */
export default defineScenario({
  id: 'pack-archetype-cover',
  title: "Make a slide the cover with the brand's cover layout",
  covers: ['slide.applyLayout'],
  maxTurns: 8,
  replay: {
    reason:
      'live only: the agent looks at the slide with query.render (as build-with-pack asks), and the memory world has no renderer',
  },
  async setup(world) {
    return packDeck(world, 'Pack cover', 2)
  },
  steps: (fx) => [
    `Make slide 1 of the Narrative deck ${deckRef(fx)} its cover, titled "Q3 review", ` +
      "with the brand's cover layout.",
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const layout = (slide as unknown as { layout?: { layoutId: string; archetype?: string } })
      .layout
    // The example pack maps the cover archetype to its `title` layout.
    c.eq("the slide follows the pack's cover layout", layout?.layoutId, 'title')
    c.eq('the slide is recorded as the cover', layout?.archetype, 'cover')
    const title = slide.objects.find((o) => o['slot'] === 'title')
    c.ok(
      'the title slot holds "Q3 review"',
      title !== undefined && norm(plainText(title)) === norm('Q3 review'),
    )
    return c.done()
  },
})
