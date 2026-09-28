import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const BADGE = { x: 200, y: 200, width: 300, height: 100 }
const SLIDE_WIDTH = 1920

const near = (a: unknown, b: number, tol = 0.5): boolean =>
  typeof a === 'number' && Math.abs(a - b) <= tol

export default defineScenario({
  id: 'badge-rotate-align',
  title: 'Rotate a badge a quarter turn and put its visible edge on the slide edge',
  covers: ['object.rotate', 'object.alignToSlide'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Launch ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Launch day') },
            {
              key: 'badge',
              object: { type: 'rectangle', ...BADGE, fill: '#e4572e', name: 'New badge' },
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
      badgeId: ids['badge']!,
      titleId: ids['title']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, turn the "New badge" rectangle a quarter turn clockwise (90 degrees). Then move it so the rotated badge sits flush against the right edge of the slide — what you see touches the edge — without changing its vertical position.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const badge = objectById(after, fx.badgeId)
    if (!c.ok('the badge still exists (same object)', badge !== undefined) || badge === undefined)
      return c.done()
    const turn = (((badge.rotation as number) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    c.ok('rotated 90 degrees clockwise', near(turn, Math.PI / 2, 0.01), String(badge.rotation))
    c.eq(
      'kept its size',
      { width: badge.width, height: badge.height },
      {
        width: BADGE.width,
        height: BADGE.height,
      },
    )
    // Turned 90 degrees the badge covers `height` px of width around its centre.
    const cx = (badge.x as number) + (badge.width as number) / 2
    const cy = (badge.y as number) + (badge.height as number) / 2
    c.ok(
      'its visible right edge is on the slide edge',
      near(cx + BADGE.height / 2, SLIDE_WIDTH),
      `visible right edge at ${cx + BADGE.height / 2}`,
    )
    c.ok(
      'its vertical position did not change',
      near(cy, BADGE.y + BADGE.height / 2),
      `centre y ${cy}`,
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
