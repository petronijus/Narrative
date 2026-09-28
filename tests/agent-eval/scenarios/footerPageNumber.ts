import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const FOOTER = {
  type: 'text',
  x: 1740,
  y: 1000,
  width: 80,
  height: 40,
  text: '00',
  fontSize: 18,
  color: '#6b7280',
  align: 'right',
  name: 'Footer',
}

export default defineScenario({
  id: 'footer-page-number',
  title: 'Turn a footer box into the live slide number, keeping its look',
  covers: ['object.slideNumber.set'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Quarterly review ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Results') },
            { key: 'footer', object: FOOTER },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    return { deckId: deck.deckId, title: deck.title, footerId: ids['footer']! }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, the small "00" box in the bottom-right corner is a placeholder. Make it show the real slide number automatically, and keep its look exactly as it is.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const footer = objectById(after, fx.footerId)
    const was = objectById(before, fx.footerId)
    if (!c.ok('the footer box still exists', footer !== undefined) || footer === undefined)
      return c.done()
    c.eq('it is the page-number field', footer['isSlideNumber'], true)
    const { isSlideNumber: _flag, ...rest } = footer
    c.eq('nothing else about it changed', rest, was)
    return c.done()
  },
})
