import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const FRAME = { x: 600, y: 300, width: 400, height: 300 }
/** The picture is larger than its frame and offset: a crop. */
const CROP = { x: 500, y: 225, width: 600, height: 450 }
const SCALE = 1.5

/** Within half a pixel — the agent may round. */
const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= 0.5

export default defineScenario({
  id: 'photo-resize-centered',
  title: 'Enlarge a cropped photo around its centre; the crop scales with it',
  covers: ['object.resize'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Offsite ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Where we went') }] }],
      world.evalFolderId,
    )
    const assetId = await world.uploadImage(deck.deckId, gradientPng(600, 450), 'lake.png')
    const [created] = await world.batch({ deckId: deck.deckId }, [
      {
        command: 'object.create',
        input: {
          slide: { index: 0 },
          object: {
            type: 'image',
            assetId,
            ...FRAME,
            imageRect: CROP,
            fit: 'cover',
            name: 'Lake photo',
          },
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
    `On slide 1 of the Narrative deck ${deckRef(fx)}, make the lake photo 50% bigger. Its centre must stay where it is, and it must keep showing exactly the same part of the picture.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const image = objectById(after, fx.imageId)
    if (!c.ok('the photo still exists (same object)', image !== undefined) || image === undefined)
      return c.done()
    const w = FRAME.width * SCALE
    const h = FRAME.height * SCALE
    const x = FRAME.x + FRAME.width / 2 - w / 2
    const y = FRAME.y + FRAME.height / 2 - h / 2
    c.ok(
      'the frame is 600 x 450 around the same centre',
      near(image.x, x) && near(image.y, y) && near(image.width, w) && near(image.height, h),
      JSON.stringify({ x: image.x, y: image.y, width: image.width, height: image.height }),
    )
    // The crop scales about the frame: same offset ratio, same size ratio.
    const crop = image.imageRect as Record<string, unknown> | undefined
    c.ok(
      'the crop scaled with the frame (the same part of the picture shows)',
      crop !== undefined &&
        near(crop['x'], x + (CROP.x - FRAME.x) * SCALE) &&
        near(crop['y'], y + (CROP.y - FRAME.y) * SCALE) &&
        near(crop['width'], CROP.width * SCALE) &&
        near(crop['height'], CROP.height * SCALE),
      JSON.stringify(crop),
    )
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
