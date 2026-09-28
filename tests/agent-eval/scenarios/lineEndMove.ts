import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'
import { drawnAt, near, type Pt } from './helpersGeometry.js'

const TARGET: Pt = { x: 1500, y: 300 }

export default defineScenario({
  id: 'line-end-move',
  title: 'Move one end of a rotated arrow to a point; the other end stays',
  covers: ['object.line.setEndpoints'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Growth ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Where we are heading') },
            {
              key: 'arrow',
              object: {
                type: 'arrow',
                x: 400,
                y: 700,
                width: 500,
                height: 0,
                p1: { x: 0, y: 0 },
                p2: { x: 500, y: 0 },
                rotation: -Math.PI / 9,
                stroke: '#1b2a4a',
                strokeWidth: 6,
                endCap: 'arrow',
                name: 'Trend arrow',
              },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    return {
      deckId: deck.deckId,
      title: deck.title,
      arrowId: ids['arrow']!,
      titleId: ids['title']!,
    }
  },
  async prepare(world, fx, notes) {
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    notes['before'] = slide
    const arrow = objectById(slide, fx.arrowId)!
    notes['start'] = drawnAt(arrow, arrow['p1'] as Pt)
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, the "Trend arrow" points to the right. Move its tip (the arrowhead end) to the slide point (1500, 300), leaving its start exactly where it is drawn now.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const start = notes['start'] as Pt
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const arrow = objectById(after, fx.arrowId)
    if (!c.ok('the arrow still exists (same object)', arrow !== undefined) || arrow === undefined)
      return c.done()
    const tip = drawnAt(arrow, arrow['p2'] as Pt)
    const tail = drawnAt(arrow, arrow['p1'] as Pt)
    c.ok('the tip is drawn at (1500, 300)', near(tip, TARGET), JSON.stringify(tip))
    c.ok('the start did not move', near(tail, start), JSON.stringify({ tail, start }))
    c.eq(
      'it is still an arrow with its head',
      { type: arrow.type, endCap: arrow['endCap'] },
      {
        type: 'arrow',
        endCap: 'arrow',
      },
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
