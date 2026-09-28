/**
 * state/clipboard.ts
 *
 * The canvas clipboard for objects: WHICH objects of which slide and deck
 * were copied, plus how they read at that moment — the objects as
 * `query.slide` returns them (formatted text, table cells, crops). Kept in
 * memory and in localStorage, so a paste can land in another tab or deck.
 *
 * Paste does the copying through commands (ADR 0010), picking the most
 * faithful path that still applies (see `usePasteObjects`):
 *
 *   - same deck, sources still there (a copy): `object.copyTo` — an exact
 *     copy of the live objects, whatever they hold;
 *   - same deck, sources gone (a cut, or deleted since): `object.insert`
 *     from the snapshot — the media is this deck's already;
 *   - another deck: the server's `object.insertFromDeck`
 *     (`POST /decks/:id/insert-objects`), which also copies the pictures,
 *     videos and fonts into that deck (media is deck-scoped) and rebinds
 *     tokens across folders.
 *
 * Unlike the slides panel's clipboard (a reference only, slideClipboard.ts)
 * this one keeps the content, because objects can be cut: after a cut the
 * sources are gone and the snapshot is all a paste has.
 */

const LS_KEY = 'narrative:clipboard'

export interface ObjectClipboard {
  /** The deck the objects were copied from. */
  deckId: string
  /** The slide they were on. */
  slideId: string
  /** Their ids, in stacking order (back to front). */
  objectIds: string[]
  /** True after a cut: the sources were deleted when they were copied. */
  cut: boolean
  /** The objects as query.slide read them when copied, in the same order. */
  objects: Record<string, unknown>[]
}

interface Stored extends ObjectClipboard {
  /** When it was copied (ms since epoch): the newest copy wins across tabs. */
  copiedAt: number
}

let clipboard: Stored | null = null

function isStored(value: unknown): value is Stored {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  return (
    typeof rec['copiedAt'] === 'number' &&
    typeof rec['deckId'] === 'string' &&
    rec['deckId'] !== '' &&
    typeof rec['slideId'] === 'string' &&
    typeof rec['cut'] === 'boolean' &&
    Array.isArray(rec['objectIds']) &&
    rec['objectIds'].every((id) => typeof id === 'string') &&
    Array.isArray(rec['objects']) &&
    rec['objects'].length > 0 &&
    rec['objects'].every((o) => typeof o === 'object' && o !== null && !Array.isArray(o))
  )
}

/** The last localStorage value read and what it parsed to: the menu asks on every render. */
let lsCache: { raw: string; value: Stored | null } | null = null

function readLS(): Stored | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return null
    if (lsCache !== null && lsCache.raw === raw) return lsCache.value
    const parsed: unknown = JSON.parse(raw)
    // Anything else — including the pre-0.10.9 format (an array of raw
    // object snapshots) — is not a clipboard this editor can paste.
    const value = isStored(parsed) ? parsed : null
    lsCache = { raw, value }
    return value
  } catch {
    return null
  }
}

function writeLS(value: Stored | null): void {
  try {
    if (value === null) localStorage.removeItem(LS_KEY)
    else localStorage.setItem(LS_KEY, JSON.stringify(value))
  } catch {
    /* quota or unavailable: the in-memory copy still works in this tab */
  }
}

/** Remember copied (or cut) objects; an entry without objects clears the clipboard. */
export function setClipboard(entry: ObjectClipboard | null): void {
  clipboard =
    entry === null || entry.objects.length === 0
      ? null
      : {
          deckId: entry.deckId,
          slideId: entry.slideId,
          objectIds: [...entry.objectIds],
          cut: entry.cut,
          objects: entry.objects.map(
            (o) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>,
          ),
          copiedAt: Date.now(),
        }
  writeLS(clipboard)
}

/** The newest clipboard, this tab's or another one's, without copying it. */
function current(): Stored | null {
  const stored = readLS()
  if (stored !== null && (clipboard === null || stored.copiedAt >= clipboard.copiedAt)) {
    clipboard = stored
  }
  return clipboard
}

/** What was copied last, in this tab or another one (the newer copy wins). */
export function readClipboard(): ObjectClipboard | null {
  const entry = current()
  if (entry === null) return null
  const { copiedAt: _copiedAt, ...rest } = entry
  void _copiedAt
  return structuredClone(rest)
}

/** Cheap enough to ask on every render: parses localStorage only when it changed. */
export function hasClipboard(): boolean {
  return current() !== null
}
