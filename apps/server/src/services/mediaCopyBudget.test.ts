/**
 * services/mediaCopyBudget.test.ts — the per-user budget for server-side
 * media copies refuses with 429 once spent, per user.
 */

import { describe, expect, it } from 'vitest'
import { createFixedWindowLimiter } from '../http/fixedWindowLimiter.js'
import { spendMediaCopyBudget } from './mediaCopyBudget.js'
import { serviceErrorOf } from '../test-support/serviceErrors.js'

describe('spendMediaCopyBudget', () => {
  it('lets a user copy up to the limit, then refuses with 429; others are unaffected', async () => {
    let t = 0
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 60_000, now: () => t })
    spendMediaCopyBudget('u1', limiter)
    spendMediaCopyBudget('u1', limiter)
    const err = await serviceErrorOf(
      Promise.resolve().then(() => spendMediaCopyBudget('u1', limiter)),
    )
    expect(err.status).toBe(429)
    expect(err.message).toMatch(/try again in 60 s/)
    expect(() => spendMediaCopyBudget('u2', limiter)).not.toThrow()
    t = 60_000
    expect(() => spendMediaCopyBudget('u1', limiter)).not.toThrow()
  })
})
