/**
 * media/mediaOwner.test.ts — storage keys follow their owner, and an id that
 * could reach into another owner's keys never names one.
 */

import { describe, expect, it } from 'vitest'
import {
  encodeTusUploadId,
  isStorageSafeId,
  mediaOriginalPath,
  mediaOwnerPrefix,
  parseTusUploadId,
} from './mediaOwner.js'

describe('mediaOwnerPrefix / mediaOriginalPath', () => {
  it('keys a deck under decks/ and a component under components/', () => {
    expect(mediaOwnerPrefix({ deckId: 'd1' })).toBe('decks/d1')
    expect(mediaOriginalPath({ componentId: 'Ab_-9' }, 'uploads', 'a1', 'png')).toBe(
      'components/Ab_-9/uploads/a1/original.png',
    )
  })

  it('refuses an id outside the nanoid alphabet', () => {
    for (const id of ['victim/uploads', '..', 'a.b', '', 'x'.repeat(65), 'a b']) {
      expect(isStorageSafeId(id), id).toBe(false)
      expect(() => mediaOwnerPrefix({ componentId: id }), id).toThrow(/cannot name storage keys/)
      expect(() => mediaOwnerPrefix({ deckId: id }), id).toThrow(/cannot name storage keys/)
    }
  })
})

describe('tus upload ids', () => {
  it('round-trip, with the deck slot empty for a component upload', () => {
    const path = mediaOriginalPath({ componentId: 'c1' }, 'uploads', 'a1', 'png')
    const id = encodeTusUploadId('a1', null, path)
    expect(parseTusUploadId(id)).toEqual({ assetId: 'a1', deckId: null, path })
  })
})
