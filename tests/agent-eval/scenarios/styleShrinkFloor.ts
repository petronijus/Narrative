import { Checks, objectById, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { textStylesOf } from './folderStylesApply.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

const FLOOR = 18

/**
 * A4.2a: a shrink floor is the folder's (the Body style's `minSize`, which
 * reaches linked boxes as `minFontSize`), while shrinking itself is each
 * box's `autofit` — one change is token.update, the other object.update.
 */
export default defineScenario({
  id: 'style-shrink-floor',
  title: 'Body text may shrink to fit its box, never below 18 px, folder-wide',
  covers: ['token.list', 'token.update', 'object.update'],
  maxTurns: 12,
  replay: true,
  async setup(world) {
    // Its own folder: it comes with the default text styles, Body among them.
    const folderId = await world.createFolder(`Shrink ${world.tag}`)
    const deck = await buildDeck(
      world,
      `Brief ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Brief') },
            {
              key: 'body',
              object: bodyBox(
                'A long paragraph of body copy that will not always fit the box it was given.',
              ),
            },
          ],
        },
      ],
      folderId,
    )
    const body = deck.objects[0]!['body']!
    await world.run({ deckId: deck.deckId }, 'text.style.apply', {
      slide: { index: 0 },
      objects: [body],
      style: 'Body',
    })
    return {
      folderId,
      deckId: deck.deckId,
      title: deck.title,
      heading: deck.objects[0]!['title']!,
      body,
    }
  },
  async prepare(world, fx, notes) {
    notes['title'] = objectById(
      await readSlide(world, { deckId: fx.deckId }, { index: 0 }),
      fx.heading,
    )
  },
  steps: (fx) => [
    `In the Narrative deck ${deckRef(fx)}: text in its folder's Body style may shrink to fit its box, but never below ${FLOOR} px. Set that up for the folder's Body style and for the Body text in this deck.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const style = (await textStylesOf(world, fx.folderId)).find((s) => s.name === 'Body') as
      | { minSize?: number }
      | undefined
    c.eq('the Body style has the floor', style?.minSize, FLOOR)
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const body = objectById(slide, fx.body)
    c.eq('the linked body box has the floor', body?.['minFontSize'], FLOOR)
    c.eq('the linked body box shrinks to fit', body?.['autofit'], 'shrink')
    c.eq('it is still linked to the Body style', body?.['textStyleId'] !== undefined, true)
    c.eq('the title is untouched', objectById(slide, fx.heading), notes['title'])
    return c.done()
  },
})
