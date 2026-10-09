/**
 * services/downloadSlots.test.ts — at most two URL downloads in flight per
 * user: a third is refused with `conflict`, a slot is freed when its scope
 * exits, and disposal is idempotent.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_URL_DOWNLOADS_PER_USER,
  acquireDownloadSlot,
  downloadsInFlight,
} from './downloadSlots.js'
import { ServiceError } from './errors.js'

describe('download slots', () => {
  it('grants two slots per user and refuses the third with conflict', () => {
    expect(MAX_URL_DOWNLOADS_PER_USER).toBe(2)
    {
      using _a = acquireDownloadSlot('u')
      using _b = acquireDownloadSlot('u')
      let refused: unknown
      try {
        acquireDownloadSlot('u')
      } catch (err) {
        refused = err
      }
      expect(refused).toBeInstanceOf(ServiceError)
      expect((refused as ServiceError).code).toBe('conflict')
      expect((refused as ServiceError).status).toBe(409)
      expect((refused as ServiceError).message).toMatch(/^another download is in progress/)
      // Other users have their own slots.
      {
        using _other = acquireDownloadSlot('v')
        expect(downloadsInFlight('v')).toBe(1)
      }
      expect(downloadsInFlight('v')).toBe(0)
      expect(downloadsInFlight('u')).toBe(2)
    }
    expect(downloadsInFlight('u')).toBe(0)
  })

  it('frees the slot when the scope exits by a throw', () => {
    expect(() => {
      using _slot = acquireDownloadSlot('u')
      throw new Error('download failed')
    }).toThrow('download failed')
    expect(downloadsInFlight('u')).toBe(0)
  })

  it('makes disposal idempotent, so a double dispose frees nobody else’s slot', () => {
    const a = acquireDownloadSlot('u')
    const b = acquireDownloadSlot('u')
    a[Symbol.dispose]()
    a[Symbol.dispose]()
    expect(downloadsInFlight('u')).toBe(1)
    b[Symbol.dispose]()
    expect(downloadsInFlight('u')).toBe(0)
  })
})
