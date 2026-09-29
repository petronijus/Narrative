import { Checks, norm, objectById, plainText, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const CELLS = [
  ['Product', 'Price', 'Units'],
  ['Lamp', '120', '14'],
  ['Chair', '340', '6'],
]
const GREY = '#f2f2f2'

type Cell = Record<string, unknown>

const cellText = (cell: Cell | undefined): string =>
  cell === undefined ? '<missing>' : norm(plainText(cell as { text?: unknown }))

export default defineScenario({
  id: 'table-resize-recolour',
  title: 'Resize a table to 4 x 4 and give every cell one background',
  covers: ['table.setSize', 'table.style.range', 'table.style.table'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Stock list ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Stock list') },
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
    const slide = { index: 0 }
    await world.batch({ deckId: deck.deckId }, [
      ...CELLS.flatMap((row, r) =>
        row.map((text, col) => ({
          command: 'text.set',
          input: { target: { slide, object: tableId, cell: { row: r, col } }, text },
        })),
      ),
      {
        command: 'table.style.cell',
        input: { slide, table: tableId, cell: { row: 1, col: 1 }, style: { fill: '#e03c31' } },
      },
    ])
    return { deckId: deck.deckId, title: deck.title, tableId }
  },
  steps: (fx) => [
    `The table on slide 1 of the Narrative deck ${deckRef(fx)} needs to be exactly 4 rows by 4 columns, keeping what is in it. Then give every cell of the table the light grey background ${GREY} — including the cell that is highlighted red at the moment.`,
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
      '4 rows of 4 cells',
      rows.map((r) => r.length),
      [4, 4, 4, 4],
    )
    c.eq(
      'the original values stay where they were; the new row and column are empty',
      rows.map((r) => r.map(cellText)),
      [...CELLS.map((r) => [...r, '']), ['', '', '', '']],
    )
    const defaults = (table['defaults'] ?? {}) as Cell
    const effective = (cell: Cell, key: string): unknown => cell[key] ?? defaults[key]
    const shown = rows.flat().map((cell) => ({
      fill: String(effective(cell, 'fill') ?? 'none').toLowerCase(),
      visible: ((effective(cell, 'fillAlpha') as number | undefined) ?? 1) > 0,
      gradient: effective(cell, 'fillStyle') !== undefined,
    }))
    c.ok(
      `every cell shows ${GREY}, solid and visible`,
      shown.length === 16 && shown.every((s) => s.fill === GREY && s.visible && !s.gradient),
      JSON.stringify(shown.filter((s) => s.fill !== GREY || !s.visible || s.gradient)),
    )
    return c.done()
  },
})
