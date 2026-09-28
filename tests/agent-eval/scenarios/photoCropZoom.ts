import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const FRAME = { x: 400, y: 300, width: 400, height: 300 }

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= 0.5

export default defineScenario({
  id: 'photo-crop-zoom',
  title: 'Zoom into a photo inside its frame; the frame stays',
  covers: ['object.crop.set'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Product shots ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('The new chair') }] }],
      world.evalFolderId,
    )
    const assetId = await world.uploadImage(deck.deckId, gradientPng(400, 300), 'chair.png')
    const [created] = await world.batch({ deckId: deck.deckId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: { type: 'image', assetId, ...FRAME, fit: 'cover', name: 'Chair photo' },
        },
      },
    ])
    const imageId = (created as { objectId: string }).objectId
    return { deckId: deck.deckId, title: deck.title, imageId, titleId: deck.objects[0]!['title']! }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, zoom into the middle of the chair photo 2x, so it shows only the central part of the picture. The photo's box on the slide must not move or change size.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const image = objectById(after, fx.imageId)
    if (!c.ok('the photo still exists (same object)', image !== undefined) || image === undefined)
      return c.done()
    c.eq(
      'the frame did not move or change size',
      { x: image.x, y: image.y, width: image.width, height: image.height },
      FRAME,
    )
    // Twice the frame, centred on it: the picture overhangs by half a frame each side.
    const crop = image.imageRect as Record<string, unknown> | undefined
    c.ok(
      'the picture is twice the frame, centred on it',
      crop !== undefined &&
        near(crop['x'], FRAME.x - FRAME.width / 2) &&
        near(crop['y'], FRAME.y - FRAME.height / 2) &&
        near(crop['width'], FRAME.width * 2) &&
        near(crop['height'], FRAME.height * 2),
      JSON.stringify(crop),
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
