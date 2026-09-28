import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const BADGE = { x: 1500, y: 60, width: 320, height: 90 }

export default defineScenario({
  id: 'objects-copy-to-slide',
  title: 'Copy a badge (shape + formatted label) to two other slides, same place',
  covers: ['object.copyTo'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Pitch ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Why us') },
            {
              key: 'badge',
              object: {
                type: 'rectangle',
                ...BADGE,
                fill: '#e4572e',
                cornerRadius: 12,
                name: 'Draft badge',
              },
            },
            {
              key: 'label',
              object: {
                type: 'text',
                x: BADGE.x + 20,
                y: BADGE.y + 20,
                width: 280,
                height: 50,
                fontSize: 32,
                color: '#ffffff',
                name: 'Draft label',
                text: {
                  paragraphs: [{ runs: [{ text: 'DRAFT', fontWeight: 700 }, { text: ' v2' }] }],
                },
              },
            },
          ],
        },
        { objects: [{ key: 'title', object: titleBox('Team') }] },
        { objects: [{ key: 'title', object: titleBox('Pricing') }] },
      ],
      world.evalFolderId,
    )
    const [s1] = deck.objects
    return {
      deckId: deck.deckId,
      title: deck.title,
      badgeId: s1!['badge']!,
      labelId: s1!['label']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['source'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}, slide 1 has a "Draft" badge in its top-right corner (a red rounded rectangle with the label "DRAFT v2" on it). Put exactly the same badge on slides 2 and 3, in the same place.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const source = notes['source'] as SlideView
    const badge = objectById(source, fx.badgeId)!
    const label = objectById(source, fx.labelId)!
    const same = (o: Record<string, unknown> | undefined, of: Record<string, unknown>): boolean => {
      if (o === undefined) return false
      const { id: _a, ...x } = o
      const { id: _b, ...y } = of
      void _a
      void _b
      return JSON.stringify(x) === JSON.stringify(y)
    }
    for (const index of [1, 2]) {
      const slide = await readSlide(world, { deckId: fx.deckId }, { index })
      c.ok(
        `slide ${index + 1} has an identical badge (shape and formatted label)`,
        slide.objects.some((o) => same(o, badge)) && slide.objects.some((o) => same(o, label)),
        JSON.stringify(slide.objects.map((o) => [o.type, o.name])),
      )
    }
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.eq('slide 1 is unchanged', after.objects, source.objects)
    return c.done()
  },
})
