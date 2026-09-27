/**
 * http/fixedWindowLimiter.test.ts — the in-process counter behind the per-IP
 * HTTP pre-limit and the WebSocket failed-authentication throttle.
 */

import { describe, it, expect } from 'vitest'
import { createFixedWindowLimiter } from './fixedWindowLimiter.js'

function clock(start = 0) {
  const c = { t: start, now: () => c.t }
  return c
}

describe('createFixedWindowLimiter', () => {
  it('allows max hits per key per window, then refuses until the window resets', () => {
    const c = clock()
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1000, now: c.now })
    expect(limiter.hit('a').allowed).toBe(true)
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a').allowed).toBe(true)
    expect(limiter.isBlocked('a')).toBe(true)
    const refused = limiter.hit('a')
    expect(refused).toMatchObject({ allowed: false, count: 3 })
    expect(refused.retryAfterMs).toBe(1000)
    expect(limiter.hit('b').allowed).toBe(true)

    c.t = 999
    expect(limiter.isBlocked('a')).toBe(true)
    c.t = 1000
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a')).toMatchObject({ allowed: true, count: 1 })
  })

  it('isBlocked never counts', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, now: () => 0 })
    for (let i = 0; i < 5; i++) expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a').allowed).toBe(true)
  })

  it('reset forgets a key', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, now: () => 0 })
    limiter.hit('a')
    limiter.hit('a')
    limiter.reset('a')
    expect(limiter.hit('a').allowed).toBe(true)
  })

  it('prunes stale keys, so memory is bounded by keys seen within one window', () => {
    const c = clock()
    const limiter = createFixedWindowLimiter({ max: 5, windowMs: 1000, now: c.now })
    for (let i = 0; i < 100; i++) limiter.hit(`ip-${i}`)
    expect(limiter.size()).toBe(100)
    c.t = 1500
    limiter.hit('fresh')
    expect(limiter.size()).toBe(1)
  })

  it('rejects nonsensical options', () => {
    expect(() => createFixedWindowLimiter({ max: 0, windowMs: 1000 })).toThrow()
    expect(() => createFixedWindowLimiter({ max: 1, windowMs: 0 })).toThrow()
  })
})
