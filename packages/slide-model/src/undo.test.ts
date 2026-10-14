/**
 * slide-model/src/undo.test.ts — what undo covers (`undoScope`): the
 * editor's undo and an agent run's revert both put back the slides, the
 * guides and the deck's meta, and leave changes from elsewhere alone.
 */

import { describe, expect, it } from 'vitest'
import { LOCAL_ORIGIN } from './mutations.js'
import { createSlideDoc } from './yDoc.js'
import { addSlide, type SlideMutationContext } from './slides.js'
import { createUndoManager } from './undo.js'
import { readDeckMeta, setDeckMeta } from './deckMeta.js'

function deck() {
  const { doc, slides } = createSlideDoc()
  const ctx: SlideMutationContext = { doc, slides }
  addSlide(ctx)
  return { doc, undoManager: createUndoManager(ctx) }
}

describe('undo scope', () => {
  it("undoes and redoes a local change of the deck's meta (style.deck.apply in the editor)", () => {
    const { doc, undoManager } = deck()
    doc.transact(
      () => setDeckMeta(doc, { variant: { background: 'dark' }, lang: 'de' }),
      LOCAL_ORIGIN,
    )
    undoManager.stopCapturing()
    doc.transact(() => setDeckMeta(doc, { fields: { client: 'Acme' } }), LOCAL_ORIGIN)
    expect(readDeckMeta(doc)).toEqual({
      variant: { background: 'dark' },
      fields: { client: 'Acme' },
      lang: 'de',
    })
    undoManager.undo()
    expect(readDeckMeta(doc)).toEqual({ variant: { background: 'dark' }, lang: 'de' })
    undoManager.undo()
    expect(readDeckMeta(doc)).toEqual({})
    undoManager.redo()
    expect(readDeckMeta(doc)).toEqual({ variant: { background: 'dark' }, lang: 'de' })
  })

  it('leaves a meta change from another origin (a collaborator, the server) on undo', () => {
    const { doc, undoManager } = deck()
    doc.transact(() => setDeckMeta(doc, { lang: 'en' }), 'remote')
    doc.transact(() => setDeckMeta(doc, { variant: { background: 'dark' } }), LOCAL_ORIGIN)
    undoManager.undo()
    expect(readDeckMeta(doc)).toEqual({ lang: 'en' })
  })
})
