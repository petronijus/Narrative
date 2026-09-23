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

import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { diffDecks, exportInMemory, formatDifferences, importInMemory } from './roundtrip.js'
import { matrixDeck } from './roundtripMatrix.js'
import { writeDeck } from './ooxml/writeDeck.js'

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

  it('takes its zip entries from the package, not the clock', async () => {
    // What made the check above flaky: entries stamped with the moment they
    // were written, so two exports a zip time tick apart differed.
    const deck = await matrixDeck()
    // Local and on an even second: what a zip's DOS time can hold exactly.
    const now = new Date(2026, 8, 24, 12, 34, 56)
    const bytes = await writeDeck(deck.slides, {
      assetLoader: async (id) => deck.assets.get(id) ?? null,
      notesBySlideId: deck.notes,
      now,
    })
    const entries = Object.values((await JSZip.loadAsync(bytes)).files)
    expect(entries.filter((e) => e.dir).map((e) => e.name)).toEqual([])
    expect(entries.filter((e) => e.date.getTime() !== now.getTime()).map((e) => e.name)).toEqual([])
  })
})
