import {
  Checks,
  isBoldWeight,
  objectById,
  paragraphsOf,
  plainText,
  readSlide,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

export default defineScenario({
  id: 'year-fix-second-occurrence',
  title: 'Correct one of several identical numbers inside a formatted paragraph',
  covers: ['text.edit'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Company history ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('History') },
            { key: 'body', object: bodyBox('x') },
          ],
        },
      ],
      world.evalFolderId,
    )
    const ids = deck.objects[0]!
    await world.batch({ deckId: deck.deckId }, [
      {
        command: 'text.set',
        input: {
          target: { slide: { index: 0 }, object: ids['body']! },
          text: {
            paragraphs: [
              {
                runs: [
                  { text: 'In 2024 we opened Berlin. By 2024 we had ' },
                  { text: 'doubled', bold: true },
                  { text: ' revenue. The plan for 2026 is Asia.' },
                ],
              },
            ],
          },
        },
      },
    ])
    return { deckId: deck.deckId, title: deck.title, bodyId: ids['body']! }
  },
  steps: (fx) => [
    `In the body text on slide 1 of the Narrative deck ${deckRef(fx)}, the SECOND "2024" (in "By 2024 we had doubled revenue") is a typo for 2025. Fix only that one number; everything else, including the bold word, must stay as it is.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const body = objectById(slide, fx.bodyId)
    if (!c.ok('the body still exists', body !== undefined) || body === undefined) return c.done()
    c.eq(
      'only the second year changed',
      plainText(body),
      'In 2024 we opened Berlin. By 2025 we had doubled revenue. The plan for 2026 is Asia.',
    )
    const runs = paragraphsOf(body).flatMap((p) => p.runs)
    c.ok(
      '"doubled" is still bold, and only it',
      runs.some((r) => r.text === 'doubled' && isBoldWeight(r.fontWeight)) &&
        runs.filter((r) => r.text !== 'doubled').every((r) => !isBoldWeight(r.fontWeight)),
      JSON.stringify(runs),
    )
    return c.done()
  },
})
