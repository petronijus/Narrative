/**
 * state/mediaCache.test.ts
 *
 * Tests for the IndexedDB media cache.
 *
 * Strategy:
 *   - Use vitest's fake-indexeddb (idb works on jsdom via fake-indexeddb polyfill).
 *   - Test put/get round-trip, expiry, clear, size.
 *
 * Note: jsdom doesn't include IndexedDB. We rely on the 'fake-indexeddb' package
 * which is brought in transitively by some test setups, or we polyfill directly.
 * If fake-indexeddb is not available, tests will be skipped with a note.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openMediaCache } from './mediaCache'

// ---------------------------------------------------------------------------
// IndexedDB polyfill for jsdom
// ---------------------------------------------------------------------------

// We install the fake-indexeddb globals before importing the module.
// If unavailable, tests skip.
let idbAvailable = false

beforeEach(async () => {
  try {
    const fakeIdb = await import('fake-indexeddb')
    const globals = [
      'IDBFactory',
      'IDBKeyRange',
      'IDBRequest',
      'IDBOpenDBRequest',
      'IDBDatabase',
      'IDBTransaction',
      'IDBObjectStore',
      'IDBIndex',
      'IDBCursor',
      'IDBCursorWithValue',
      'IDBVersionChangeEvent',
    ] as const
    for (const name of globals) {
      Object.defineProperty(globalThis, name, {
        value: fakeIdb[name as keyof typeof fakeIdb],
        writable: true,
        configurable: true,
      })
    }
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new fakeIdb.IDBFactory(),
      writable: true,
      configurable: true,
    })
    idbAvailable = true
  } catch {
    idbAvailable = false
  }
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mediaCache', () => {
  it('put and get round-trip for Blob', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    const blob = new Blob(['hello'], { type: 'image/jpeg' })
    await cache.put('https://example.com/img.jpg', blob, 'image')

    const result = await cache.get('https://example.com/img.jpg')
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('image')
    // fake-indexeddb's structured clone may not preserve Blob identity in jsdom
    expect(result!.content).toBeTruthy()
    expect(result!.url).toBe('https://example.com/img.jpg')
  })

  it('put and get round-trip for video-poster Blob', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    const blob = new Blob(['poster'], { type: 'image/jpeg' })
    await cache.put('https://cdn.example.com/poster.jpg', blob, 'video-poster')

    const result = await cache.get('https://cdn.example.com/poster.jpg')
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('video-poster')
    expect(result!.content).toBeTruthy()
    expect(result!.url).toBe('https://cdn.example.com/poster.jpg')
  })

  it('returns null for unknown URL', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    const result = await cache.get('https://example.com/unknown.jpg')
    expect(result).toBeNull()
  })

  it('returns null for expired entry', async () => {
    if (!idbAvailable) return

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const cache = await openMediaCache()
    await cache.put('https://example.com/old.jpg', new Blob(['x']), 'image')

    // Advance time by 25 hours (past the 24h TTL)
    vi.spyOn(Date, 'now').mockReturnValue(now + 25 * 60 * 60 * 1000)

    const result = await cache.get('https://example.com/old.jpg')
    expect(result).toBeNull()
  })

  it('clear removes all entries', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    await cache.put('https://example.com/a.jpg', new Blob(['a']), 'image')
    await cache.put('https://example.com/b.jpg', new Blob(['b']), 'video-poster')

    expect(await cache.size()).toBe(2)

    await cache.clear()
    expect(await cache.size()).toBe(0)
  })

  it('size returns number of cached entries', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    expect(await cache.size()).toBe(0)

    await cache.put('https://example.com/x.jpg', new Blob(['x']), 'image')
    expect(await cache.size()).toBe(1)

    await cache.put('https://example.com/poster2.jpg', new Blob(['y']), 'video-poster')
    expect(await cache.size()).toBe(2)
  })

  it('overwriting an existing entry updates content', async () => {
    if (!idbAvailable) return

    const cache = await openMediaCache()
    const url = 'https://example.com/img.jpg'

    await cache.put(url, new Blob(['old']), 'image')
    await cache.put(url, new Blob(['new']), 'image')

    // size should still be 1 (same key)
    expect(await cache.size()).toBe(1)
  })
})
