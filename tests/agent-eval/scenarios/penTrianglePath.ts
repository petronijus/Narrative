import { Checks, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'
import { drawnAt, near, type Pt } from './helpersGeometry.js'

const CORNERS: Pt[] = [
  { x: 960, y: 200 },
  { x: 1160, y: 540 },
  { x: 760, y: 540 },
]

export default defineScenario({
  id: 'pen-triangle-path',
  title: 'Draw a closed, filled path through given points',
  covers: ['object.path.create'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Warning signs ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Caution') }] }],
      world.evalFolderId,
    )
    return { deckId: deck.deckId, title: deck.title, titleId: deck.objects[0]!['title']! }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, draw a closed free-form path — a triangle through the points (960, 200), (1160, 540) and (760, 540) in slide pixels — filled with #e03c31.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const added = after.objects.filter((o) => !before.objects.some((b) => b.id === o.id))
    if (!c.ok('exactly one object was added', added.length === 1, String(added.length)))
      return c.done()
    const path = added[0]!
    c.eq(
      'it is a closed path',
      { type: path.type, closed: path['closed'] },
      {
        type: 'path',
        closed: true,
      },
    )
    c.eq('filled red', path['fill'], '#e03c31')
    const drawn = ((path['anchors'] as Pt[] | undefined) ?? []).map((a) => drawnAt(path, a))
    c.ok(
      'its points are drawn at the three corners, in order',
      drawn.length === 3 && drawn.every((d, i) => near(d, CORNERS[i]!)),
      JSON.stringify(drawn),
    )
    return c.done()
  },
})
