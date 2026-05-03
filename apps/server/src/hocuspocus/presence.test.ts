/**
 * presence.test.ts — covers the pure helper. The live snapshot path
 * (activeEditorsByDeck) reads from a running Hocuspocus instance and is
 * exercised end-to-end by the e2e suite, not unit-tested here.
 */
import { describe, expect, it } from 'vitest'
import { deckIdFromDocName } from './presence.js'

describe('deckIdFromDocName', () => {
  it('strips the deck: prefix', () => {
    expect(deckIdFromDocName('deck:abc123')).toBe('abc123')
  })
  it('treats legacy bare names as deck ids', () => {
    expect(deckIdFromDocName('legacy-id')).toBe('legacy-id')
  })
  it('rejects folder/component docs', () => {
    expect(deckIdFromDocName('folder:f1')).toBeNull()
    expect(deckIdFromDocName('component:c1')).toBeNull()
  })
})
