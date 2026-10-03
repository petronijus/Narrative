/**
 * state/thumbnailRetry.test.ts — the retry policy of failed thumbnail
 * renders: backoff, the per-slide budget, and the renderer-level stop.
 */

import { describe, expect, it } from 'vitest'
import {
  decideThumbnailRetry,
  THUMBNAIL_RETRY_POLICY,
  type ThumbnailRetryPolicy,
} from './thumbnailRetry.js'

const policy: ThumbnailRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 300,
  rendererFailureLimit: 5,
}

describe('decideThumbnailRetry', () => {
  it('backs off exponentially up to the cap', () => {
    const delays = [1, 2, 3].map((slideFailures) =>
      decideThumbnailRetry({ slideFailures, consecutiveFailures: slideFailures }, policy),
    )
    expect(delays).toEqual([
      { kind: 'retry', delayMs: 100 },
      { kind: 'retry', delayMs: 200 },
      { kind: 'retry', delayMs: 300 },
    ])
  })

  it('gives a slide up once its retries are spent', () => {
    expect(decideThumbnailRetry({ slideFailures: 4, consecutiveFailures: 4 }, policy)).toEqual({
      kind: 'give-up',
    })
  })

  it('parks every slide while the renderer keeps failing, whatever their budget', () => {
    expect(decideThumbnailRetry({ slideFailures: 1, consecutiveFailures: 5 }, policy)).toEqual({
      kind: 'park',
    })
    expect(decideThumbnailRetry({ slideFailures: 9, consecutiveFailures: 5 }, policy)).toEqual({
      kind: 'park',
    })
  })

  it('bounds the default policy: every slide stops within a minute, the renderer before a deck is retried', () => {
    let total = 0
    for (let failures = 1; ; failures++) {
      const decision = decideThumbnailRetry({ slideFailures: failures, consecutiveFailures: 1 })
      if (decision.kind !== 'retry') break
      total += decision.delayMs
    }
    expect(total).toBeLessThanOrEqual(60_000)
    expect(THUMBNAIL_RETRY_POLICY.rendererFailureLimit).toBeLessThan(10)
  })
})
