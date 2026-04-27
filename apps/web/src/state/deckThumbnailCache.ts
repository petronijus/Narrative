/**
 * state/deckThumbnailCache.ts
 *
 * P13: deck-list previews. The home page wants a thumbnail per deck
 * but rendering them on demand requires N Hocuspocus connections —
 * heavy and slow. Instead we cache the first-slide thumbnail in
 * localStorage every time the editor renders one for a deck. The
 * home page reads from that cache and falls back to "No preview"
 * for decks the current device hasn't opened.
 *
 * Storage shape:
 *   localStorage[STORAGE_KEY] = JSON({
 *     [deckId]: { dataUrl: string; updatedAt: number }
 *   })
 *
 * Bounded to MAX_ENTRIES via simple LRU (drop oldest on overflow).
 * Each entry's data URL is ~10–40 KB, so 50 entries fit in ~2 MB —
 * well under the 5 MB localStorage limit per origin.
 */

const STORAGE_KEY = 'narrative:deckThumbs'
const MAX_ENTRIES = 50

interface DeckThumbnailEntry {
  dataUrl: string
  updatedAt: number
}

type Cache = Record<string, DeckThumbnailEntry>

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    return parsed as Cache
  } catch {
    return {}
  }
}

function writeCache(cache: Cache): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch (err) {
    // Quota exceeded or storage disabled — drop the write silently.
    console.warn('[deckThumbnailCache] write failed', err)
  }
}

/** Write or replace the thumbnail for a deck. */
export function setDeckThumbnail(deckId: string, dataUrl: string): void {
  const cache = readCache()
  cache[deckId] = { dataUrl, updatedAt: Date.now() }

  // LRU evict — drop the oldest entries beyond MAX_ENTRIES.
  const ids = Object.keys(cache)
  if (ids.length > MAX_ENTRIES) {
    ids
      .sort((a, b) => (cache[a]?.updatedAt ?? 0) - (cache[b]?.updatedAt ?? 0))
      .slice(0, ids.length - MAX_ENTRIES)
      .forEach((id) => delete cache[id])
  }

  writeCache(cache)
}

/** Read the cached thumbnail (data URL) for a deck. */
export function getDeckThumbnail(deckId: string): string | null {
  const cache = readCache()
  return cache[deckId]?.dataUrl ?? null
}

/** Drop a deck's thumbnail (call on deck delete). */
export function deleteDeckThumbnail(deckId: string): void {
  const cache = readCache()
  if (!(deckId in cache)) return
  delete cache[deckId]
  writeCache(cache)
}

/** Read the entire cache as a deckId → dataUrl map. */
export function getAllDeckThumbnails(): Record<string, string> {
  const cache = readCache()
  const out: Record<string, string> = {}
  for (const id in cache) {
    const entry = cache[id]
    if (entry !== undefined) out[id] = entry.dataUrl
  }
  return out
}
