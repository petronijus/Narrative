import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'
import { drawnAt, near, type Pt } from './helpersGeometry.js'

const CARD = { x: 600, y: 300, width: 400, height: 300 }

export default defineScenario({
  id: 'shape-corner-to-path',
  title: 'Pull one corner of a rectangle; it becomes a path, the rest stays',
  covers: ['object.path.fromShape', 'object.path.setAnchors'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Roadmap ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Next steps') },
            {
              key: 'card',
              object: { type: 'rectangle', ...CARD, fill: '#2e86ab', name: 'Card' },
            },
          ],
          animations: [{ objectKey: 'card', preset: 'fadeIn', trigger: 'onClick' }],
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
    `On slide 1 of the Narrative deck ${deckRef(fx)}, pull the top-right corner of the "Card" rectangle 120 px up, so the card becomes a slanted shape. The other three corners must stay exactly where they are, and keep the card's fade-in animation.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const card = objectById(after, fx.cardId)
    if (
      !c.ok('the card is still the same object (same id)', card !== undefined) ||
      card === undefined
    )
      return c.done()
    c.eq(
      'it is now a closed path, still blue',
      { type: card.type, closed: card['closed'], fill: card['fill'] },
      {
        type: 'path',
        closed: true,
        fill: '#2e86ab',
      },
    )
    const drawn = ((card['anchors'] as Pt[] | undefined) ?? []).map((a) => drawnAt(card, a))
    const want: Pt[] = [
      { x: CARD.x, y: CARD.y },
      { x: CARD.x + CARD.width, y: CARD.y - 120 },
      { x: CARD.x + CARD.width, y: CARD.y + CARD.height },
      { x: CARD.x, y: CARD.y + CARD.height },
    ]
    c.ok(
      'the top-right corner moved up 120 px and the others stayed',
      drawn.length === 4 && want.every((w) => drawn.some((d) => near(d, w))),
      JSON.stringify(drawn),
    )
    c.eq(
      'the fade-in animation still targets the card',
      after.animations.map((a) => a.objectId),
      before.animations.map((a) => a.objectId),
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
