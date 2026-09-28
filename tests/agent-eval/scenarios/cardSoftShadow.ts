import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const CARD = { x: 660, y: 360, width: 600, height: 400 }

export default defineScenario({
  id: 'card-soft-shadow',
  title: "Give a card the editor's default shadow, only softer",
  covers: ['object.effects.shadow'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Pricing ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Plans') },
            { key: 'card', object: { type: 'rectangle', ...CARD, fill: '#ffffff', name: 'Card' } },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    return { deckId: deck.deckId, title: deck.title, cardId: ids['card']!, titleId: ids['title']! }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, give the "Card" rectangle Narrative's usual default drop shadow, but softer: blur 20 instead of the default. Keep everything else about the shadow at the default.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const card = objectById(after, fx.cardId)
    if (!c.ok('the card still exists', card !== undefined) || card === undefined) return c.done()
    c.eq('the default shadow with blur 20', card['shadow'], {
      color: '#000000',
      blur: 20,
      offsetX: 4,
      offsetY: 4,
      opacity: 0.5,
    })
    c.eq(
      'the card did not move',
      { x: card.x, y: card.y, width: card.width, height: card.height },
      CARD,
    )
    c.eq('the title has no shadow', objectById(after, fx.titleId), objectById(before, fx.titleId))
    return c.done()
  },
})
