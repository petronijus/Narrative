import {
  Checks,
  isBoldWeight,
  norm,
  objectById,
  paragraphsOf,
  plainText,
  readSlide,
} from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { bodyBox, buildDeck, deckRef, titleBox } from './helpers.js'

type Cell = Record<string, unknown>

export default defineScenario({
  id: 'product-rename-everywhere',
  title: 'Rename a product in every text box and table cell of a deck, keeping formatting',
  covers: ['text.replace'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Launch plan ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Acme One launch') },
            { key: 'body', object: bodyBox('x') },
          ],
        },
        {
          objects: [
            { key: 'note', object: bodyBox('Acme One ships in May; the Acme team is ready.') },
            {
              key: 'table',
              object: { type: 'table', x: 120, y: 700, width: 900, height: 200, rows: 2, cols: 2 },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    const [s1, s2] = deck.objects
    await world.batch({ deckId: deck.deckId }, [
      {
        command: 'text.set',
        input: {
          target: { slide: { index: 0 }, object: s1!['body']! },
          text: {
            paragraphs: [
              { runs: [{ text: 'Why ' }, { text: 'Acme One', bold: true }, { text: ' wins' }] },
            ],
          },
        },
      },
      ...[
        ['Product', 'Price'],
        ['Acme One', '99'],
      ].flatMap((row, r) =>
        row.map((text, col) => ({
          command: 'text.set',
          input: {
            target: { slide: { index: 1 }, object: s2!['table']!, cell: { row: r, col } },
            text,
          },
        })),
      ),
    ])
    return {
      deckId: deck.deckId,
      title: deck.title,
      titleId: s1!['title']!,
      bodyId: s1!['body']!,
      noteId: s2!['note']!,
      tableId: s2!['table']!,
    }
  },
  steps: (fx) => [
    `The product "Acme One" has been renamed to "Acme Pro". Update every mention of it in the Narrative deck ${deckRef(fx)} — every slide, including tables — and keep the formatting of the text as it is.`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const s1 = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const s2 = await readSlide(world, { deckId: fx.deckId }, { index: 1 })
    const title = objectById(s1, fx.titleId)
    const body = objectById(s1, fx.bodyId)
    const note = objectById(s2, fx.noteId)
    const table = objectById(s2, fx.tableId)
    if (
      !c.ok(
        'all four objects still exist',
        [title, body, note, table].every((o) => o !== undefined),
      )
    )
      return c.done()
    c.eq('the title reads "Acme Pro launch"', norm(plainText(title!)), 'Acme Pro launch')
    c.eq(
      'the note reads the new name, "Acme team" untouched',
      norm(plainText(note!)),
      'Acme Pro ships in May; the Acme team is ready.',
    )
    const rows = (table!.rows ?? []) as Cell[][]
    c.eq(
      'the table names the new product',
      rows.map((r) => r.map((cell) => norm(plainText(cell as { text?: unknown })))),
      [
        ['Product', 'Price'],
        ['Acme Pro', '99'],
      ],
    )
    const runs = paragraphsOf(body!)[0]?.runs ?? []
    c.eq('the body reads "Why Acme Pro wins"', norm(plainText(body!)), 'Why Acme Pro wins')
    c.ok(
      'the product name in the body is still bold, the rest is not',
      runs.some((r) => r.text.includes('Acme Pro') && isBoldWeight(r.fontWeight)) &&
        runs.filter((r) => !r.text.includes('Acme Pro')).every((r) => !isBoldWeight(r.fontWeight)),
      JSON.stringify(runs),
    )
    return c.done()
  },
})
