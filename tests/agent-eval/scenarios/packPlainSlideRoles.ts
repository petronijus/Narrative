import { Checks, norm, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'
import { packDeck } from './packHelpers.js'

/**
 * Put a slide that was never laid out onto the pack's layouts, keeping its
 * text (A5.1: the agent gives the objects roles, the layout moves them in).
 */
export default defineScenario({
  id: 'pack-plain-slide-roles',
  title: "Put a plain slide onto the brand's layouts, keeping its text",
  covers: ['object.update', 'slide.applyLayout'],
  maxTurns: 10,
  replay: {
    reason:
      'live only: the agent looks at the slide with query.render (as build-with-pack asks), and the memory world has no renderer',
  },
  async setup(world) {
    const pack = await packDeck(world, 'Pack roles', 0)
    // A deck in the pack's folder with a slide made by hand.
    const deck = await buildDeck(
      world,
      `Pack roles plain ${world.tag}`,
      [
        {
          objects: [
            {
              object: {
                type: 'text',
                x: 100,
                y: 60,
                width: 1500,
                height: 120,
                fontSize: 64,
                text: 'Revenue grew 12 %',
              },
            },
            {
              object: {
                type: 'text',
                x: 100,
                y: 260,
                width: 1200,
                height: 400,
                fontSize: 32,
                text: 'Europe +12 %\n\nAmericas +8 %',
              },
            },
          ],
        },
      ],
      pack.folderId,
    )
    return { ...pack, deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `Put slide 1 of the Narrative deck ${deckRef(fx)} onto its brand's layouts, keeping its text.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const layout = (slide as unknown as { layout?: { layoutId: string } }).layout
    c.eq('the slide follows the title-and-bullets layout', layout?.layoutId, 'title-bullets')
    const text = (slot: string) => {
      const o = slide.objects.find((x) => x['slot'] === slot)
      return o === undefined ? '' : norm(plainText(o))
    }
    c.ok('the headline is in the title slot', text('title').includes(norm('Revenue grew 12 %')))
    c.ok(
      'both regions are in the bullets slot',
      text('bullets').includes('Europe') && text('bullets').includes('Americas'),
    )
    const headlines = slide.objects.filter((o) => /revenue grew/i.test(plainText(o)))
    c.eq('the headline is there once, not left behind as well', headlines.length, 1)
    return c.done()
  },
})
