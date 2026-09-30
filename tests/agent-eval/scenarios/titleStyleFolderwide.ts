import { Checks, callsOf, objectById, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { textStylesOf } from './folderStylesApply.js'
import { buildDeck, deckRef, titleBox, bodyBox } from './helpers.js'

const SIZE = 88
const WEIGHT = 800

export default defineScenario({
  id: 'title-style-folderwide',
  title: "Change the folder's Title style; every linked title in the folder follows",
  covers: ['token.list', 'token.update'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const folderId = await world.createFolder(`Brand ${world.tag}`)
    const a = await buildDeck(
      world,
      `Kickoff ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Kickoff') },
            { key: 'note', object: bodyBox('Agenda follows.') },
          ],
        },
      ],
      folderId,
    )
    const b = await buildDeck(
      world,
      `Retrospective ${world.tag}`,
      [{ objects: [{ key: 'title', object: titleBox('Retrospective') }] }],
      folderId,
    )
    for (const deck of [a, b])
      await world.run({ deckId: deck.deckId }, 'text.style.apply', {
        slide: { index: 0 },
        objects: [deck.objects[0]!['title']!],
        style: 'Title',
      })
    // Deck B's title has its own size, set by hand.
    await world.run({ deckId: b.deckId }, 'text.setBoxTypography', {
      slide: { index: 0 },
      objects: [b.objects[0]!['title']!],
      style: { fontSize: 70 },
    })
    return {
      folderId,
      a: {
        deckId: a.deckId,
        title: a.title,
        heading: a.objects[0]!['title']!,
        note: a.objects[0]!['note']!,
      },
      b: { deckId: b.deckId, title: b.title, heading: b.objects[0]!['title']! },
    }
  },
  async prepare(world, fx, notes) {
    notes['note'] = objectById(
      await readSlide(world, { deckId: fx.a.deckId }, { index: 0 }),
      fx.a.note,
    )
  },
  steps: (fx) => [
    `In the folder of the Narrative deck ${deckRef(fx.a)}, make the Title text style ${SIZE} px and weight ${WEIGHT} — every title in the folder should follow.`,
  ],
  async grade({ world, fixture: fx, notes, transcript }) {
    const c = new Checks()
    const title = (await textStylesOf(world, fx.folderId)).find((s) => s.name === 'Title')
    c.eq('the Title style is the new size', title?.size, SIZE)
    c.eq('the Title style is the new weight', title?.weight, WEIGHT)
    const a = await readSlide(world, { deckId: fx.a.deckId }, { index: 0 })
    const b = await readSlide(world, { deckId: fx.b.deckId }, { index: 0 })
    c.eq("deck A's title follows the size", objectById(a, fx.a.heading)?.fontSize, SIZE)
    c.eq("deck A's title follows the weight", objectById(a, fx.a.heading)?.fontWeight, WEIGHT)
    c.eq("deck B's title follows the weight", objectById(b, fx.b.heading)?.fontWeight, WEIGHT)
    c.eq("deck B's title keeps the size set by hand", objectById(b, fx.b.heading)?.fontSize, 70)
    c.eq('the unlinked box is untouched', objectById(a, fx.a.note), notes['note'])
    c.eq(
      'the style was changed, not each box',
      [...callsOf(transcript, 'text.setBoxTypography'), ...callsOf(transcript, 'object.update')]
        .length,
      0,
    )
    return c.done()
  },
})
