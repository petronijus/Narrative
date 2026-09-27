import {
  Checks,
  isBoldWeight,
  norm,
  objectById,
  paragraphText,
  paragraphsOf,
  plainText,
  readSlide,
  type SlideView,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

const PLACEHOLDER = 'Add your points here'
const POINTS = ['Demand is up', 'Costs are down', 'Competitors are slow']

export default defineScenario({
  id: 'bullets-second-bold',
  title: 'Build a 3-bullet list with the second bullet bold',
  covers: ['text.set', 'text.list', 'text.format'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Why now ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Why now') },
            { key: 'body', object: bodyBox(PLACEHOLDER, { fontSize: 32 }) },
          ],
        },
      ],
      world.evalFolderId,
    )
    return {
      deckId: deck.deckId,
      title: deck.title,
      titleId: deck.objects[0]!['title']!,
      bodyId: deck.objects[0]!['body']!,
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, replace the placeholder text "${PLACEHOLDER}" with a bulleted list of exactly three points: ${POINTS.map((p) => `"${p}"`).join(', ')}. Make the second bullet bold and leave the other two regular.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.ok(
      'the placeholder text is gone',
      !after.objects.some((o) => o.type === 'text' && plainText(o).includes(PLACEHOLDER)),
    )
    const lists = after.objects.filter(
      (o) => o.type === 'text' && plainText(o).includes(POINTS[0]!),
    )
    if (!c.eq('exactly one text box holds the list', lists.length, 1)) return c.done()
    const box = lists[0]!
    const paragraphs = paragraphsOf(box)
    c.eq(
      'the list has exactly the three points, in order',
      paragraphs.map((p) => norm(paragraphText(p))),
      POINTS,
    )
    c.eq(
      'every paragraph is a bullet',
      paragraphs.map((p) => p.list ?? null),
      ['bullet', 'bullet', 'bullet'],
    )
    const boldness = paragraphs.map((p) => {
      const runs = p.runs.filter((r) => r.text.trim().length > 0)
      if (runs.length === 0) return 'empty'
      const bold = runs.map((r) => isBoldWeight(r.fontWeight ?? box.fontWeight))
      return bold.every(Boolean) ? 'bold' : bold.some(Boolean) ? 'mixed' : 'regular'
    })
    c.eq('only the second bullet is bold (all of it)', boldness, ['regular', 'bold', 'regular'])
    c.eq('the title is untouched', objectById(after, fx.titleId), objectById(before, fx.titleId))
    return c.done()
  },
})
