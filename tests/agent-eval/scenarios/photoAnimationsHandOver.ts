import { Checks, objectById, readSlide, type SlideView } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const PHOTO = { x: 260, y: 300, width: 640, height: 420 }

/**
 * A new picture sits where the old one was; the old one carries two steps
 * (a fade-in with the title, then a move across the slide). The trap:
 * object.delete removes the deleted object's steps too, so deleting first
 * loses them. animation.retarget hands the steps over as they are — same
 * place in the order, timing and params; removing and re-adding them works
 * too if everything is carried over.
 */
export default defineScenario({
  id: 'photo-animations-hand-over',
  title: "Give a replacement picture the old one's animations, then delete the old one",
  covers: ['animation.retarget'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Case study ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Case study') },
            {
              key: 'old',
              object: { type: 'rectangle', ...PHOTO, fill: '#9aa5b1', name: 'Old photo' },
            },
            {
              key: 'new',
              object: { type: 'rectangle', ...PHOTO, fill: '#2f6fed', name: 'New photo' },
            },
          ],
          animations: [
            { key: 'titleFade', objectKey: 'title', preset: 'fadeIn' },
            { key: 'fade', objectKey: 'old', preset: 'fadeIn', trigger: 'withPrevious' },
            {
              key: 'move',
              objectKey: 'old',
              preset: 'moveTo',
              duration: 1.2,
              delay: 0.4,
              easing: 'sine.inOut',
              params: { targetX: 1380, targetY: 510 },
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
      titleId: ids['title']!,
      oldId: ids['old']!,
      newId: ids['new']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, I put "New photo" exactly where "Old photo" is. Give "New photo" the animations "Old photo" has — the same ones, in the same place in the sequence, with the same timing and settings — and then delete "Old photo".`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.ok('"Old photo" is deleted', objectById(after, fx.oldId) === undefined)
    c.ok('"New photo" is still there', objectById(after, fx.newId) !== undefined)
    const shape = (s: SlideView['animations'][number], objectId: string) => ({
      objectId: s.objectId === objectId ? 'photo' : s.objectId,
      preset: s.preset,
      trigger: s.trigger,
      duration: s.duration,
      delay: s.delay,
      easing: s.easing,
      params: s['params'] ?? null,
      start: s.start,
    })
    c.eq(
      'the timeline is the same, with "New photo" in place of "Old photo"',
      after.animations.map((s) => shape(s, fx.newId)),
      before.animations.map((s) => shape(s, fx.oldId)),
    )
    return c.done()
  },
})
