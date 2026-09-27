/**
 * services/downloadSlots.test.ts — at most two URL downloads in flight per
 * user: a third is refused with `conflict`, and releases are idempotent.
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
    const a = acquireDownloadSlot('u')
    const b = acquireDownloadSlot('u')
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
    const other = acquireDownloadSlot('v')
    other()
    a()
    b()
    expect(downloadsInFlight('u')).toBe(0)
  })

  it('makes release idempotent, so a double release frees nobody else’s slot', () => {
    const a = acquireDownloadSlot('u')
    const b = acquireDownloadSlot('u')
    a()
    a()
    expect(downloadsInFlight('u')).toBe(1)
    b()
    expect(downloadsInFlight('u')).toBe(0)
  })
})
