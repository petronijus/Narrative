import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const TILT = Math.PI / 6
const SHAPE = { x: 800, y: 400, width: 240, height: 160 }

export default defineScenario({
  id: 'shape-flip-in-place',
  title: 'Mirror a tilted shape horizontally in place',
  covers: ['object.flip'],
  maxTurns: 8,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Signposts ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Which way?') },
            {
              key: 'pointer',
              object: {
                type: 'triangle',
                ...SHAPE,
                rotation: TILT,
                fill: '#2e86ab',
                name: 'Pointer',
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
      pointerId: ids['pointer']!,
      titleId: ids['title']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, flip the tilted "Pointer" triangle horizontally, so it becomes its own mirror image where it stands.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const pointer = objectById(after, fx.pointerId)
    if (
      !c.ok('the triangle still exists (same object)', pointer !== undefined) ||
      pointer === undefined
    )
      return c.done()
    c.eq(
      'mirrored horizontally (flipH), not vertically',
      { flipH: pointer.flipH, flipV: pointer.flipV },
      {
        flipH: true,
        flipV: undefined,
      },
    )
    // A world-space mirror of a tilted shape also mirrors its tilt.
    c.ok(
      'the tilt is mirrored too (30 degrees becomes -30)',
      typeof pointer.rotation === 'number' && Math.abs(pointer.rotation + TILT) < 0.01,
      String(pointer.rotation),
    )
    c.eq(
      'it stayed where it was',
      { x: pointer.x, y: pointer.y, width: pointer.width, height: pointer.height },
      SHAPE,
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
