import {
  Checks,
  effectiveRuns,
  norm,
  objectById,
  plainText,
  readSlide,
  sameFamily,
  type SlideView,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef } from './helpers.js'

const FONT = 'Inter'
const COLUMNS = [100, 700, 1300]

function heading(
  x: number,
  text: unknown,
  fontFamily: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'text',
    x,
    y: 120,
    width: 520,
    height: 80,
    text,
    fontSize: 44,
    fontFamily,
    ...extra,
  }
}

function body(x: number, text: string) {
  return {
    type: 'text',
    x,
    y: 230,
    width: 520,
    height: 200,
    text,
    fontSize: 22,
    fontFamily: 'Georgia',
  }
}

export default defineScenario({
  id: 'heading-one-font',
  title: 'Make every heading on a slide Inter Bold (inline overrides included)',
  covers: ['object.update', 'text.format'],
  maxTurns: 14,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Results overview ${world.tag}`,
      [
        {
          objects: [
            { key: 'h1', object: heading(COLUMNS[0]!, 'Revenue', 'Georgia') },
            { key: 'b1', object: body(COLUMNS[0]!, 'Revenue grew 12% on strong EMEA demand.') },
            // One heading carries an inline font override on part of its text:
            // box-level font alone does not restyle it (text.format's description).
            {
              key: 'h2',
              object: heading(
                COLUMNS[1]!,
                {
                  paragraphs: [
                    {
                      runs: [{ text: 'Operating ' }, { text: 'costs', fontFamily: 'Courier New' }],
                    },
                  ],
                },
                'Arial',
              ),
            },
            { key: 'b2', object: body(COLUMNS[1]!, 'Costs stayed flat year over year.') },
            {
              key: 'h3',
              object: heading(COLUMNS[2]!, 'Outlook', 'Verdana', { fontWeight: 'bold' }),
            },
            { key: 'b3', object: body(COLUMNS[2]!, 'We expect growth to continue.') },
          ],
        },
      ],
      world.evalFolderId,
    )
    const o = deck.objects[0]!
    return {
      deckId: deck.deckId,
      title: deck.title,
      headings: [o['h1']!, o['h2']!, o['h3']!],
      bodies: [o['b1']!, o['b2']!, o['b3']!],
    }
  },
  async prepare(world, fx, notes) {
    notes['before'] = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
  },
  steps: (fx) => [
    `On slide 1 of the Narrative deck ${deckRef(fx)}, make every heading use the font ${FONT} Bold. Leave the body text exactly as it is.`,
  ],
  async grade({ world, fixture: fx, notes }) {
    const c = new Checks()
    const before = notes['before'] as SlideView
    const after = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    c.eq(
      'no object was added or removed',
      after.objects.map((o) => o.id).sort(),
      before.objects.map((o) => o.id).sort(),
    )
    fx.headings.forEach((id, i) => {
      const obj = objectById(after, id)
      if (!c.ok(`heading ${i + 1} still exists`, obj !== undefined) || obj === undefined) return
      const runs = effectiveRuns(obj)
      const wrongFont = runs.filter((r) => !sameFamily(r.fontFamily, FONT))
      c.ok(
        `heading ${i + 1} renders entirely in ${FONT}`,
        runs.length > 0 && wrongFont.length === 0,
        `runs not in ${FONT}: ${JSON.stringify(wrongFont)}`,
      )
      const notBold = runs.filter((r) => !r.bold)
      c.ok(
        `heading ${i + 1} renders entirely bold`,
        runs.length > 0 && notBold.length === 0,
        `not bold: ${JSON.stringify(notBold)}`,
      )
      const was = objectById(before, id)!
      c.eq(`heading ${i + 1} keeps its text`, norm(plainText(obj)), norm(plainText(was)))
    })
    fx.bodies.forEach((id, i) => {
      c.eq(`body ${i + 1} is untouched`, objectById(after, id), objectById(before, id))
    })
    return c.done()
  },
})
