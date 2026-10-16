import { Checks, norm, plainText, readDeck, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'
import { richPackDeck } from './packHelpers.js'

const text = (x: number, y: number, w: number, h: number, size: number, t: string) => ({
  object: { type: 'text', x, y, width: w, height: h, fontSize: size, text: t },
})

/** A plain deck of three hand-made slides put onto the brand's layouts, by judgment (A5.5). */
export default defineScenario({
  id: 'restyle-no-provenance',
  title: "Put a plain deck onto the brand's layouts, slide by slide",
  covers: ['object.update', 'slide.applyLayout'],
  maxTurns: 25,
  replay: {
    reason: 'live only: the agent looks at the slides with query.render (as restyle-lite asks)',
  },
  async setup(world) {
    const pack = await richPackDeck(world, 'No provenance', 0)
    const deck = await buildDeck(
      world,
      `No provenance plain ${world.tag}`,
      [
        {
          objects: [
            text(200, 400, 1500, 140, 96, 'Q3 review'),
            text(200, 580, 1500, 80, 40, 'Board meeting, October'),
          ],
        },
        {
          objects: [
            text(100, 60, 1600, 120, 60, 'Revenue grew in every region'),
            text(100, 260, 1200, 500, 32, 'Europe +12 %\n\nAmericas +8 %\n\nAsia +15 %'),
          ],
        },
        {
          objects: [
            text(
              240,
              360,
              1440,
              240,
              56,
              'Growth came from the customers we did not have a year ago.',
            ),
            text(240, 680, 800, 60, 30, 'CFO'),
          ],
        },
      ],
      pack.folderId,
    )
    return { ...pack, deckId: deck.deckId, title: deck.title, slideIds: deck.slideIds }
  },
  steps: (fx) => [
    `Put every slide of the Narrative deck ${deckRef(fx)} onto its brand's layouts, keeping its text.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const deck = await readDeck(world, fx.deckId)
    c.eq('it still has three slides', deck.slideCount, 3)
    c.ok(
      'every slide follows a layout',
      deck.slides.every((s) => s.layout !== undefined),
    )
    const all = async (i: number) =>
      (await readSlide(world, { deckId: fx.deckId }, { index: i })).objects
        .map((o) => norm(plainText(o)))
        .join(' | ')
    const [one, two, three] = [await all(0), await all(1), await all(2)]
    c.ok('slide 1 keeps its title', one.includes('Q3 review'))
    c.ok(
      'slide 2 keeps its regions',
      ['Europe', 'Americas', 'Asia'].every((r) => two.includes(r)),
    )
    c.ok('slide 3 keeps its quote', three.includes('customers we did not have'))
    c.ok(
      'no text is there twice',
      [one, two, three].every(
        (s) => s.split('Revenue grew').length <= 2 && s.split('Q3 review').length <= 2,
      ),
    )
    return c.done()
  },
})
