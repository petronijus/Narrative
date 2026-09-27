import { Checks, norm, objectById, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const CELLS = [
  ['Region', 'Q1', 'Q2'],
  ['EMEA', '12', '14'],
  ['APAC', '9', '8'],
]

type Cell = Record<string, unknown>

function cellText(cell: Cell | undefined): string {
  return cell === undefined ? '<missing>' : norm(plainText(cell as { text?: unknown }))
}

function isCovered(cell: Cell | undefined): boolean {
  return (
    cell !== undefined && (cell['mergeOriginR'] !== undefined || cell['mergeOriginC'] !== undefined)
  )
}

export default defineScenario({
  id: 'table-merge-add-column',
  title: 'Merge a table header row, then add a column',
  covers: ['table.merge', 'table.col.insert'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Regional results ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Regional results') },
            {
              key: 'table',
              object: { type: 'table', x: 160, y: 260, width: 900, height: 300, rows: 3, cols: 3 },
            },
          ],
        },
      ],
      world.evalFolderId,
    )
    const tableId = deck.objects[0]!['table']!
    await world.batch(
      { deckId: deck.deckId },
      CELLS.flatMap((row, r) =>
        row.map((text, col) => ({
          command: 'text.set',
          input: { target: { slide: { index: 0 }, object: tableId, cell: { row: r, col } }, text },
        })),
      ),
    )
    return { deckId: deck.deckId, title: deck.title, tableId }
  },
  steps: (fx) => [
    `In the table on slide 1 of the Narrative deck ${deckRef(fx)}: first merge the entire top row into one header cell, then add one new column at the right end of the table (the new column does not need to be part of the header).`,
  ],
  async grade({ world, fixture: fx }) {
    const c = new Checks()
    const slide = await readSlide(world, { deckId: fx.deckId }, { index: 0 })
    const table = objectById(slide, fx.tableId)
    if (
      !c.ok('the table still exists (same object)', table?.type === 'table') ||
      table === undefined
    )
      return c.done()
    const rows = (table.rows ?? []) as Cell[][]
    c.eq(
      '3 rows of 4 cells',
      rows.map((r) => r.length),
      [4, 4, 4],
    )
    c.eq('4 column widths', table.colWidths?.length, 4)
    const header = rows[0]?.[0]
    c.eq(
      'the header cell spans the original 3 columns, 1 row',
      { gridSpan: header?.['gridSpan'], rowSpan: header?.['rowSpan'] ?? 1 },
      { gridSpan: 3, rowSpan: 1 },
    )
    c.eq('the header shows "Region"', cellText(header), 'Region')
    c.ok(
      'top-row cells 2 and 3 are covered by the header merge',
      isCovered(rows[0]?.[1]) && isCovered(rows[0]?.[2]),
    )
    const added = rows[0]?.[3]
    c.ok(
      'the new top-right cell is its own cell',
      added !== undefined &&
        !isCovered(added) &&
        ((added['gridSpan'] as number | undefined) ?? 1) === 1,
    )
    c.eq(
      'body rows keep their values; the new column is empty',
      rows.slice(1).map((r) => r.map(cellText)),
      [
        ['EMEA', '12', '14', ''],
        ['APAC', '9', '8', ''],
      ],
    )
    return c.done()
  },
})
