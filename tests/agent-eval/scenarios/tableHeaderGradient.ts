import { Checks, objectById, readSlide } from '../lib/checks.js'
import { defineScenario } from '../lib/types.js'
import { buildDeck, deckRef, titleBox } from './helpers.js'

const NAVY = '#1b2a4a'

type Cell = Record<string, unknown>
interface Gradient {
  kind?: string
  angleDeg?: number
  stops?: Array<{ color: string; offset: number }>
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

export default defineScenario({
  id: 'table-header-gradient',
  title: "Give a table's header row a gradient from its own colour",
  covers: ['object.fill.gradient'],
  maxTurns: 10,
  replay: true,
  async setup(world) {
    const deck = await buildDeck(
      world,
      `Quarterly table ${world.tag}`,
      [
        {
          objects: [
            { key: 'title', object: titleBox('Quarterly figures') },
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
    await world.batch({ deckId: deck.deckId }, [
      {
        command: 'table.style.range',
        input: {
          slide: { index: 0 },
          table: tableId,
          range: { from: { row: 0, col: 0 }, to: { row: 0, col: 2 } },
          style: { fill: NAVY, color: '#ffffff' },
        },
      },
    ])
    return { deckId: deck.deckId, title: deck.title, tableId }
  },
  steps: (fx) => [
    `In the table on slide 1 of the Narrative deck ${deckRef(fx)}, the header row (the first row) is navy. Give each header cell a top-to-bottom gradient that starts with that navy and runs into a darker shade of it. The other rows stay as they are.`,
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
    const defaults = (table['defaults'] ?? {}) as Cell
    const base = channels(NAVY)
    rows[0]?.forEach((cell, col) => {
      const g = (cell['fillStyle'] ?? defaults['fillStyle']) as Gradient | undefined
      const stops = [...(g?.stops ?? [])].sort((a, b) => a.offset - b.offset)
      const first = stops[0]
      const last = stops[stops.length - 1]
      c.ok(
        `header cell ${col}: a linear gradient running top to bottom`,
        g?.kind === 'linearGradient' && Math.abs(((g.angleDeg ?? 0) % 360) - 0) < 0.5,
        JSON.stringify(g),
      )
      c.ok(
        `header cell ${col}: it starts with the navy`,
        first !== undefined && first.offset === 0 && first.color.toLowerCase() === NAVY,
        JSON.stringify(first),
      )
      c.ok(
        `header cell ${col}: it ends in a darker shade of that navy`,
        last !== undefined &&
          last.offset === 1 &&
          channels(last.color).every((v, i) => v <= base[i]!) &&
          channels(last.color).some((v, i) => v < base[i]!),
        JSON.stringify(last),
      )
    })
    c.ok(
      'the other rows have no gradient',
      rows
        .slice(1)
        .flat()
        .every((cell) => (cell['fillStyle'] ?? defaults['fillStyle']) === undefined),
    )
    c.eq(
      'the header keeps its white text',
      rows[0]?.map((cell) => String(cell['color'] ?? '').toLowerCase()),
      ['#ffffff', '#ffffff', '#ffffff'],
    )
    return c.done()
  },
})
