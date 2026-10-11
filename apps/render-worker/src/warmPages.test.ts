import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { WarmPages, type WarmPage } from './warmPages.js'

/** A context that closes like Playwright's (a 'close' event), and its page. */
function fakePage(
  deckId = 'd1',
): WarmPage & { closed: () => boolean; closeListeners: () => number } {
  const events = new EventEmitter()
  let closed = false
  const context = {
    once: (event: string, fn: () => void) => events.once(event, fn),
    close: async () => {
      if (closed) return
      closed = true
      events.emit('close')
    },
  } as unknown as BrowserContext
  const page = { isClosed: () => closed } as unknown as Page
  return {
    deckId,
    context,
    page,
    pageErrors: ['old'],
    closed: () => closed,
    closeListeners: () => events.listenerCount('close'),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WarmPages', () => {
  const log = () => undefined

  it('hands a kept page back to its session and deck only', () => {
    const pages = new WarmPages({ max: 2, idleMs: 60_000, log })
    const a = fakePage('d1')
    pages.keep('nrr_a', a)
    expect(pages.take('nrr_b', 'd1')).toBeUndefined()
    const back = pages.take('nrr_a', 'd1')
    expect(back?.page).toBe(a.page)
    // Errors of the job before do not leak into the next one.
    expect(back?.pageErrors).toEqual([])
    // Taken out until kept again.
    expect(pages.take('nrr_a', 'd1')).toBeUndefined()
  })

  it('watches a page kept job after job with one close listener', () => {
    const pages = new WarmPages({ max: 1, idleMs: 60_000, log })
    const a = fakePage('d1')
    for (let job = 0; job < 12; job++) {
      pages.keep('nrr_a', job === 0 ? a : pages.take('nrr_a', 'd1')!)
    }
    expect(a.closeListeners()).toBe(1)
  })

  it('closes a page asked for another deck', async () => {
    const pages = new WarmPages({ max: 1, idleMs: 60_000, log })
    const a = fakePage('d1')
    pages.keep('nrr_a', a)
    expect(pages.take('nrr_a', 'd2')).toBeUndefined()
    await Promise.resolve()
    expect(a.closed()).toBe(true)
  })

  it('keeps at most `max` pages, the oldest going first, and closes idle ones', async () => {
    vi.useFakeTimers()
    const pages = new WarmPages({ max: 1, idleMs: 1_000, log })
    const a = fakePage()
    const b = fakePage()
    pages.keep('nrr_a', a)
    pages.keep('nrr_b', b)
    await Promise.resolve()
    expect(a.closed()).toBe(true)
    expect(pages.size).toBe(1)
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(b.closed()).toBe(true)
    expect(pages.size).toBe(0)
  })

  it('forgets a page whose context closed (the browser went), and keeps none with max 0', async () => {
    const pages = new WarmPages({ max: 2, idleMs: 60_000, log })
    const a = fakePage()
    pages.keep('nrr_a', a)
    await a.context.close()
    expect(pages.size).toBe(0)
    const none = new WarmPages({ max: 0, idleMs: 60_000, log })
    const b = fakePage()
    none.keep('nrr_b', b)
    await Promise.resolve()
    expect(b.closed()).toBe(true)
    expect(none.size).toBe(0)
  })
})
