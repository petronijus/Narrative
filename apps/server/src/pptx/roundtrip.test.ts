/**
 * pptx/roundtrip.test.ts
 *
 * The import/export invariant over every object type and every field the
 * model has (see roundtrip.ts and roundtripMatrix.ts):
 *
 *   model M → export → import = M
 *
 * A field added to the model without both sides of the translation fails
 * here.
 */

import { describe, expect, it } from 'vitest'
import { diffDecks, exportInMemory, formatDifferences, importInMemory } from './roundtrip.js'
import { matrixDeck } from './roundtripMatrix.js'

describe('pptx round trip: model → export → import', () => {
  it('reproduces every object type and field exactly', async () => {
    const deck = await matrixDeck()
    const exported = await exportInMemory(deck)
    const back = await importInMemory(exported)
    const differences = diffDecks(deck, back)
    expect(differences, `\n${formatDifferences(differences)}\n`).toEqual([])
  })

  it('is stable: a second export of the imported deck is byte-identical', async () => {
    const deck = await matrixDeck()
    const first = await exportInMemory(deck)
    const second = await exportInMemory(await importInMemory(first))
    const third = await exportInMemory(await importInMemory(second))
    expect(third.equals(second)).toBe(true)
  })
})
