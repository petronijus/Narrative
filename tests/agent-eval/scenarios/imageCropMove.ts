import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { gradientPng } from '../lib/png.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const FRAME = { x: 400, y: 300, width: 400, height: 300 }
/** The picture is larger than its frame and offset: a crop. */
const CROP = { x: 300, y: 225, width: 600, height: 450 }
const DX = 200
const DY = 100

export default defineScenario({
  id: 'image-crop-move',
  title: 'Move a cropped image; the crop moves with it',
  covers: ['object.move', 'object.update'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Team intro ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Our team') }] }],
      world.evalFolderId,
    )
    const assetId = await world.uploadImage(deck.deckId, gradientPng(600, 450), 'team.png')
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
            name: 'Team photo',
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
    `On slide 1 of the Narrative deck ${deckRef(fx)}, move the photo ${DX} px to the right and ${DY} px down.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const image = objectById(after, fx.imageId)
    if (!c.ok('the photo still exists (same object)', image !== undefined) || image === undefined)
      return c.done()
    c.eq(
      'the frame moved by (+200, +100) and kept its size',
      { x: image.x, y: image.y, width: image.width, height: image.height },
      { x: FRAME.x + DX, y: FRAME.y + DY, width: FRAME.width, height: FRAME.height },
    )
    c.eq('the crop (imageRect) moved with the frame and kept its size', image.imageRect, {
      x: CROP.x + DX,
      y: CROP.y + DY,
      width: CROP.width,
      height: CROP.height,
    })
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    c.eq('nothing else was added or removed', after.objects.length, before.objects.length)
    return c.done()
  },
})
