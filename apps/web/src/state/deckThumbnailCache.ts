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
 * PERF-3: per-deck storage keys.
 *
 *   Old shape (pre-PERF-3):
 *     localStorage['narrative:deckThumbs'] = JSON({
 *       [deckId]: { dataUrl: string; updatedAt: number }
 *     })
 *
 *   The old shape meant *every* setDeckThumbnail re-parsed AND
 *   re-serialised the whole ~2 MB / 50-entry blob and wrote it back
 *   synchronously. Fired after every 500 ms-debounced thumbnail
 *   re-render while editing slide 1, that's a 25–70 ms main-thread
 *   stall per keystroke-burst — stacked on the re-render storm.
 *
 *   New shape: one localStorage key per deck —
 *     localStorage['narrative:deckThumb:<deckId>'] =
 *       JSON({ dataUrl: string; updatedAt: number })
 *     localStorage['narrative:deckThumbIndex'] =
 *       JSON(string[])   // deck ids, for bounded LRU + bulk read
 *
 *   A write now serialises ONE entry (a few KB) plus the small index
 *   array, never the whole store. Reads are served from an in-memory
 *   parsed map so getAllDeckThumbnails / getDeckThumbnail don't pay
 *   JSON.parse on the hot path either.
 *
 * Bounded to MAX_ENTRIES via simple LRU (drop oldest on overflow).
 * Each entry's data URL is ~10–40 KB, so 50 entries fit in ~2 MB —
 * well under the 5 MB localStorage limit per origin.
 *
 * Backward compat: the old single-blob key is migrated on first read
 * (migrateLegacyBlob) so existing users keep their thumbnails.
 */

const LEGACY_KEY = 'narrative:deckThumbs'
const ENTRY_PREFIX = 'narrative:deckThumb:'
const INDEX_KEY = 'narrative:deckThumbIndex'
const MAX_ENTRIES = 50

interface DeckThumbnailEntry {
  dataUrl: string
  updatedAt: number
}

function entryKey(deckId: string): string {
  return ENTRY_PREFIX + deckId
}

/**
 * In-memory mirror of the on-disk store. Lazily hydrated on first
 * access so reads never re-parse localStorage and writes only touch
 * the one changed key. `null` until hydrated.
 */
let memCache: Map<string, DeckThumbnailEntry> | null = null

function readIndex(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function writeIndex(ids: string[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(ids))
  } catch (err) {
    console.warn('[deckThumbnailCache] index write failed', err)
  }
}

function readEntry(deckId: string): DeckThumbnailEntry | null {
  try {
    const raw = localStorage.getItem(entryKey(deckId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as DeckThumbnailEntry).dataUrl !== 'string'
    ) {
      return null
    }
    const entry = parsed as DeckThumbnailEntry
    return {
      dataUrl: entry.dataUrl,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * Migrate the pre-PERF-3 single-blob cache into per-deck keys. Runs
 * once: after a successful migration the legacy key is removed so it
 * never re-runs and never double-counts entries. Best-effort — a
 * failure here just means the user starts from an empty cache.
 */
function migrateLegacyBlob(into: Map<string, DeckThumbnailEntry>): void {
  let raw: string | null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return
  }
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object') {
      for (const [deckId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          value !== null &&
          typeof value === 'object' &&
          typeof (value as DeckThumbnailEntry).dataUrl === 'string' &&
          // Don't clobber a fresher per-deck entry written since.
          !into.has(deckId)
        ) {
          const entry = value as DeckThumbnailEntry
          const migrated: DeckThumbnailEntry = {
            dataUrl: entry.dataUrl,
            updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
          }
          into.set(deckId, migrated)
          try {
            localStorage.setItem(entryKey(deckId), JSON.stringify(migrated))
          } catch (err) {
            console.warn('[deckThumbnailCache] migrate write failed', err)
          }
        }
      }
    }
  } catch {
    /* Corrupt legacy blob — drop it. */
  }
  // Persist the (possibly extended) index and retire the legacy blob.
  writeIndex([...into.keys()])
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* non-fatal */
  }
}

/** Hydrate the in-memory mirror from per-deck keys (+ legacy migrate). */
function hydrate(): Map<string, DeckThumbnailEntry> {
  if (memCache !== null) return memCache
  const map = new Map<string, DeckThumbnailEntry>()
  for (const id of readIndex()) {
    const entry = readEntry(id)
    if (entry !== null) map.set(id, entry)
  }
  // Pull in any legacy single-blob cache exactly once.
  migrateLegacyBlob(map)
  memCache = map
  return map
}

/** Test seam: forget the hydrated mirror so the next call re-reads disk. */
export function __resetDeckThumbnailCacheForTest(): void {
  memCache = null
}

/** Write or replace the thumbnail for a deck. */
export function setDeckThumbnail(deckId: string, dataUrl: string): void {
  const cache = hydrate()
  const entry: DeckThumbnailEntry = { dataUrl, updatedAt: Date.now() }
  cache.set(deckId, entry)

  // LRU evict — drop the oldest entries beyond MAX_ENTRIES.
  const evicted: string[] = []
  if (cache.size > MAX_ENTRIES) {
    const ordered = [...cache.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [id] of ordered.slice(0, cache.size - MAX_ENTRIES)) {
      cache.delete(id)
      evicted.push(id)
    }
  }

  // Persist ONLY the changed entry + the small index (and any evicted
  // entry removals) — never the whole store.
  try {
    localStorage.setItem(entryKey(deckId), JSON.stringify(entry))
  } catch (err) {
    // Quota exceeded or storage disabled — drop the write silently.
    console.warn('[deckThumbnailCache] write failed', err)
  }
  for (const id of evicted) {
    try {
      localStorage.removeItem(entryKey(id))
    } catch {
      /* non-fatal */
    }
  }
  writeIndex([...cache.keys()])
}

/** Read the cached thumbnail (data URL) for a deck. */
export function getDeckThumbnail(deckId: string): string | null {
  return hydrate().get(deckId)?.dataUrl ?? null
}

/** Drop a deck's thumbnail (call on deck delete). */
export function deleteDeckThumbnail(deckId: string): void {
  const cache = hydrate()
  if (!cache.has(deckId)) return
  cache.delete(deckId)
  try {
    localStorage.removeItem(entryKey(deckId))
  } catch {
    /* non-fatal */
  }
  writeIndex([...cache.keys()])
}

/** Read the entire cache as a deckId → dataUrl map. */
export function getAllDeckThumbnails(): Record<string, string> {
  const cache = hydrate()
  const out: Record<string, string> = {}
  for (const [id, entry] of cache) {
    out[id] = entry.dataUrl
  }
  return out
}
