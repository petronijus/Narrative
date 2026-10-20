import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'playwright-core'
import { WarmPages, type WarmPage } from './warmPages.js'

/** A context that closes like Playwright's (a 'close' event), and its page. */
function fakePage(
  name = 'deck:d1',
  generation = 0,
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
    name,
    context,
    page,
    pageErrors: ['old'],
    generation,
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
    const a = fakePage('deck:d1')
    pages.keep('nrr_a', a)
    expect(pages.take('nrr_b', 'deck:d1')).toBeUndefined()
    const back = pages.take('nrr_a', 'deck:d1')
    expect(back?.page).toBe(a.page)
    // Errors of the job before do not leak into the next one.
    expect(back?.pageErrors).toEqual([])
    // Taken out until kept again.
    expect(pages.take('nrr_a', 'deck:d1')).toBeUndefined()
  })

  it('watches a page kept job after job with one close listener', () => {
    const pages = new WarmPages({ max: 1, idleMs: 60_000, log })
    const a = fakePage('deck:d1')
    for (let job = 0; job < 12; job++) {
      pages.keep('nrr_a', job === 0 ? a : pages.take('nrr_a', 'deck:d1')!)
    }
    expect(a.closeListeners()).toBe(1)
  })

  it('never hands a session page to another deck as is; it stays a spare', async () => {
    const pages = new WarmPages({ max: 1, idleMs: 60_000, log })
    const a = fakePage('deck:d1')
    pages.keep('nrr_a', a)
    expect(pages.take('nrr_a', 'deck:d2')).toBeUndefined()
    await Promise.resolve()
    expect([a.closed(), pages.size]).toEqual([false, 1])
  })

  it('hands out the oldest idle page as a spare, without its token or errors', () => {
    const pages = new WarmPages({ max: 3, idleMs: 60_000, log })
    const a = fakePage('deck:d1')
    const b = fakePage('deck:d2')
    pages.keep('nrr_a', a)
    pages.keep('nrr_b', b)
    const spare = pages.takeSpare()
    expect(spare?.page).toBe(a.page)
    expect(spare).not.toHaveProperty('token')
    expect(spare?.pageErrors).toEqual([])
    // Taken out: its session cannot get it back, the other page is still kept.
    expect(pages.take('nrr_a', 'deck:d1')).toBeUndefined()
    expect(pages.takeSpare()?.page).toBe(b.page)
    expect(pages.takeSpare()).toBeUndefined()
  })

  it('skips spares whose page closed meanwhile', async () => {
    const pages = new WarmPages({ max: 2, idleMs: 60_000, log })
    const a = fakePage('deck:d1')
    const b = fakePage('deck:d2')
    pages.keep('nrr_a', a)
    pages.keep('nrr_b', b)
    ;(a.page as unknown as { isClosed: () => boolean }).isClosed = () => true
    expect(pages.takeSpare()?.page).toBe(b.page)
    await Promise.resolve()
    expect(a.closed()).toBe(true)
  })

  it('evicts the oldest idle page for memory, and says when there is none', async () => {
    const pages = new WarmPages({ max: 2, idleMs: 60_000, log })
    const a = fakePage('deck:d1')
    const b = fakePage('deck:d2')
    pages.keep('nrr_a', a)
    pages.keep('nrr_b', b)
    expect(pages.evictOldest('memory')).toBe(true)
    await Promise.resolve()
    expect([a.closed(), b.closed(), pages.size]).toEqual([true, false, 1])
    expect(pages.evictOldest('memory')).toBe(true)
    expect(pages.evictOldest('memory')).toBe(false)
  })

  it('does not keep a page of an earlier generation (its browser was retired)', async () => {
    const pages = new WarmPages({ max: 2, idleMs: 60_000, log })
    const running = fakePage('deck:d1', pages.generation)
    pages.closeAll('failed job')
    pages.keep('nrr_a', running)
    await Promise.resolve()
    expect([running.closed(), pages.size]).toEqual([true, 0])
    const fresh = fakePage('deck:d1', pages.generation)
    pages.keep('nrr_a', fresh)
    expect(pages.size).toBe(1)
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
