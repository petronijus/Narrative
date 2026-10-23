// @vitest-environment node
/**
 * state/deckThumbnailCache.test.ts
 *
 * PERF-3 coverage: per-deck localStorage keys.
 *   - A write touches only the one deck's key (not a whole-store rewrite),
 *     so other decks' raw entries are byte-untouched.
 *   - The legacy single-blob cache is migrated on first read and retired.
 *   - get / getAll / delete / LRU eviction still behave.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  setDeckThumbnail,
  getDeckThumbnail,
  getAllDeckThumbnails,
  deleteDeckThumbnail,
  __resetDeckThumbnailCacheForTest,
} from './deckThumbnailCache'

const ENTRY_PREFIX = 'narrative:deckThumb:'
const INDEX_KEY = 'narrative:deckThumbIndex'
const LEGACY_KEY = 'narrative:deckThumbs'

// jsdom in this vitest config doesn't expose a working localStorage, so we
// install a minimal in-memory Storage shim on globalThis for these tests.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
  __resetDeckThumbnailCacheForTest()
})

describe('deckThumbnailCache — per-deck writes', () => {
  it('round-trips a single thumbnail', () => {
    setDeckThumbnail('a', 'data:image/png;base64,AAA')
    expect(getDeckThumbnail('a')).toBe('data:image/png;base64,AAA')
    expect(getDeckThumbnail('missing')).toBeNull()
  })

  it('stores each deck under its own key', () => {
    setDeckThumbnail('a', 'AAA')
    setDeckThumbnail('b', 'BBB')
    expect(localStorage.getItem(ENTRY_PREFIX + 'a')).toContain('AAA')
    expect(localStorage.getItem(ENTRY_PREFIX + 'b')).toContain('BBB')
    expect(JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]')).toEqual(
      expect.arrayContaining(['a', 'b']),
    )
  })

  it('writing one deck does NOT rewrite another deck’s stored entry', () => {
    setDeckThumbnail('a', 'AAA')
    const rawABefore = localStorage.getItem(ENTRY_PREFIX + 'a')

    // Spy on setItem to prove deck "a"'s key is never re-serialised when we
    // write deck "b". Only b's entry + the index should be touched.
    const setItem = vi.spyOn(localStorage, 'setItem')
    setDeckThumbnail('b', 'BBB')
    const touchedKeys = setItem.mock.calls.map((c) => c[0])
    setItem.mockRestore()

    expect(touchedKeys).toContain(ENTRY_PREFIX + 'b')
    expect(touchedKeys).toContain(INDEX_KEY)
    expect(touchedKeys).not.toContain(ENTRY_PREFIX + 'a')
    // a's raw bytes are byte-identical — never re-written.
    expect(localStorage.getItem(ENTRY_PREFIX + 'a')).toBe(rawABefore)
  })

  it('getAllDeckThumbnails returns the whole map', () => {
    setDeckThumbnail('a', 'AAA')
    setDeckThumbnail('b', 'BBB')
    expect(getAllDeckThumbnails()).toEqual({ a: 'AAA', b: 'BBB' })
  })

  it('delete removes only the target deck', () => {
    setDeckThumbnail('a', 'AAA')
    setDeckThumbnail('b', 'BBB')
    deleteDeckThumbnail('a')
    expect(getDeckThumbnail('a')).toBeNull()
    expect(getDeckThumbnail('b')).toBe('BBB')
    expect(localStorage.getItem(ENTRY_PREFIX + 'a')).toBeNull()
  })

  it('evicts the oldest entries beyond the 50-entry bound', () => {
    let now = 1
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now++)
    for (let i = 0; i < 55; i++) setDeckThumbnail(`deck-${i}`, `T${i}`)
    nowSpy.mockRestore()

    // The 5 oldest (deck-0..deck-4) are evicted; 50 remain.
    expect(getDeckThumbnail('deck-0')).toBeNull()
    expect(getDeckThumbnail('deck-4')).toBeNull()
    expect(getDeckThumbnail('deck-5')).toBe('T5')
    expect(getDeckThumbnail('deck-54')).toBe('T54')
    expect(Object.keys(getAllDeckThumbnails())).toHaveLength(50)
    // Evicted entries' raw keys are gone from storage too.
    expect(localStorage.getItem(ENTRY_PREFIX + 'deck-0')).toBeNull()
  })
})

describe('deckThumbnailCache — legacy single-blob migration', () => {
  it('migrates an old single-blob cache on first read and retires it', () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        a: { dataUrl: 'AAA', updatedAt: 100 },
        b: { dataUrl: 'BBB', updatedAt: 200 },
      }),
    )

    // First access triggers migration.
    expect(getDeckThumbnail('a')).toBe('AAA')
    expect(getDeckThumbnail('b')).toBe('BBB')

    // Migrated into per-deck keys and the legacy blob is removed.
    expect(localStorage.getItem(ENTRY_PREFIX + 'a')).toContain('AAA')
    expect(localStorage.getItem(ENTRY_PREFIX + 'b')).toContain('BBB')
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
    expect(getAllDeckThumbnails()).toEqual({ a: 'AAA', b: 'BBB' })
  })

  it('does not clobber a fresher per-deck entry during migration', () => {
    // A per-deck entry already exists (written post-upgrade)...
    setDeckThumbnail('a', 'FRESH')
    __resetDeckThumbnailCacheForTest()
    // ...and a stale legacy blob still lingers with the same id.
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ a: { dataUrl: 'STALE', updatedAt: 1 } }))
    expect(getDeckThumbnail('a')).toBe('FRESH')
  })

  it('survives a corrupt legacy blob', () => {
    localStorage.setItem(LEGACY_KEY, '{not json')
    expect(getDeckThumbnail('a')).toBeNull()
    expect(getAllDeckThumbnails()).toEqual({})
  })
})
