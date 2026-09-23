/**
 * scripts/pptxRoundtrip.ts
 *
 * Import a .pptx, export it, import the export, and report everything that
 * changed on the way — the invariant in `pptx/roundtrip.ts`, run on a real
 * deck (client decks stay out of the repo, so they are checked here rather
 * than in the test suite).
 *
 *   pnpm --filter server exec tsx src/scripts/pptxRoundtrip.ts <deck.pptx> [--out exported.pptx] [--detail]
 *   pnpm --filter server exec tsx src/scripts/pptxRoundtrip.ts --matrix [--out exported.pptx] [--detail]
 *
 * `--matrix` runs the other direction on the test suite's feature matrix
 * (`pptx/roundtripMatrix.ts`): model → export → import.
 *
 * Prints differences grouped by kind (the path with indexes collapsed), each
 * with a count, the slides it occurs on and one example. `--detail` lists
 * every difference.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import {
  diffDecks,
  exportInMemory,
  importInMemory,
  roundTrip,
  type Difference,
  type ImportedDeck,
} from '../pptx/roundtrip.js'
import { matrixDeck } from '../pptx/roundtripMatrix.js'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : undefined
const file = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1)
const matrix = args.includes('--matrix')
if (file === undefined && !matrix) {
  console.error('usage: pptxRoundtrip.ts <deck.pptx> | --matrix [--out exported.pptx] [--detail]')
  process.exit(2)
}

let differences: Difference[]
let exported: Buffer
let before: ImportedDeck
if (matrix) {
  before = await matrixDeck()
  exported = await exportInMemory(before)
  differences = diffDecks(before, await importInMemory(exported))
} else {
  ;({ differences, exported, before } = await roundTrip(readFileSync(file!)))
}
if (out !== undefined) writeFileSync(out, exported)

const short = (v: unknown): string => {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 90 ? `${s.slice(0, 87)}...` : s
}

const groups = new Map<string, Difference[]>()
for (const d of differences) {
  const kind = d.path.replace(/\[\d+\]/g, '[]')
  const list = groups.get(kind) ?? []
  list.push(d)
  groups.set(kind, list)
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)

console.log(
  `${before.slides.length} slides, ${differences.length} differences in ${groups.size} kinds\n`,
)
for (const [kind, list] of sorted) {
  const slides = [...new Set(list.map((d) => d.slide))].slice(0, 12).join(',')
  const ex = list[0]!
  console.log(`${String(list.length).padStart(5)}  ${kind}`)
  console.log(`       slides ${slides}${list.length > 12 ? ',…' : ''}`)
  console.log(`       e.g. slide ${ex.slide} ${ex.path}: ${short(ex.before)} → ${short(ex.after)}`)
}
if (args.includes('--detail')) {
  console.log('\n--- all differences ---')
  for (const d of differences)
    console.log(`slide ${d.slide} ${d.path}: ${short(d.before)} → ${short(d.after)}`)
}
process.exit(differences.length === 0 ? 0 : 1)
