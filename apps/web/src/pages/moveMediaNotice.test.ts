// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { moveMediaNotice } from './moveMediaNotice.js'

const entry = { deckId: 'd1', copied: 2, unresolved: 0, copyFailed: 0 }

describe('moveMediaNotice', () => {
  it('says nothing when the linked media came along, or nothing moved across folders', () => {
    expect(moveMediaNotice({ movedCount: 1, media: [entry] })).toBeNull()
    expect(moveMediaNotice({ movedCount: 0 })).toBeNull()
  })

  it('counts the copies that failed after the deck moved', () => {
    expect(moveMediaNotice({ movedCount: 1, media: [{ ...entry, copyFailed: 1 }] })).toMatch(
      /^The deck moved, but 1 picture or video added while it was moving could not be copied/,
    )
    expect(
      moveMediaNotice({
        movedCount: 2,
        media: [
          { ...entry, copyFailed: 2 },
          { ...entry, deckId: 'd2', copyFailed: 1 },
        ],
      }),
    ).toMatch(/but 3 pictures or videos added/)
  })

  it('says the check failed when the pass after the move failed as a whole', () => {
    expect(
      moveMediaNotice({ movedCount: 1, media: [{ ...entry, error: 'storage down' }] }),
    ).toMatch(/checking it for pictures or videos added while it was moving failed/)
  })
})
