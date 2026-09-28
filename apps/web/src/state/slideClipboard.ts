/**
 * state/slideClipboard.ts
 *
 * The slides panel's clipboard for whole slides: WHICH slides of WHICH deck
 * were copied — a reference, not a copy of their content. Kept in memory and
 * in localStorage, so a paste can land in another tab or another deck.
 *
 * Paste does the copying, from the live source (ADR 0010: the editor writes
 * only through commands, and what a paste has to get right is theirs):
 *
 *   - into the SAME deck: `slide.copyTo` — whole slides (rich text, tables,
 *     animations, notes, name, outline) in one undo step;
 *   - into ANOTHER deck: the server's slide insert (`deck.insertFrom`'s deck
 *     source, `POST /decks/:id/insert-slides`), which also copies the media
 *     the slides show into the target deck — media is deck-scoped, so a
 *     slide carried over as plain JSON would show broken images — rebinds
 *     token references across folders, and requires editor access to the
 *     source deck (copying out of a deck is exporting it).
 *
 * Because paste reads the source as it is at paste time, a slide edited
 * after copying pastes with the edit, and one deleted meanwhile is gone.
 */

const LS_KEY = 'narrative:slideClipboard'

export interface SlideClipboard {
  /** The deck the slides were copied from. */
  deckId: string
  /** The copied slides, in deck order. */
  slideIds: string[]
}

interface Stored extends SlideClipboard {
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
    Array.isArray(rec['slideIds']) &&
    rec['slideIds'].length > 0 &&
    rec['slideIds'].every((id) => typeof id === 'string' && id !== '')
  )
}

function readLS(): Stored | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    // Anything else — including the pre-0.10.2 format (an array of slide
    // snapshots) — is not a clipboard this editor can paste.
    return isStored(parsed) ? parsed : null
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

/** Remember `slideIds` (in deck order) of `deckId` as copied; an empty list clears. */
export function setSlideClipboard(deckId: string, slideIds: ReadonlyArray<string>): void {
  clipboard =
    slideIds.length === 0 ? null : { deckId, slideIds: [...slideIds], copiedAt: Date.now() }
  writeLS(clipboard)
}

/** What was copied last, in this tab or another one (the newer copy wins). */
export function readSlideClipboard(): SlideClipboard | null {
  const stored = readLS()
  if (stored !== null && (clipboard === null || stored.copiedAt >= clipboard.copiedAt)) {
    clipboard = stored
  }
  return clipboard === null ? null : { deckId: clipboard.deckId, slideIds: [...clipboard.slideIds] }
}

export function hasSlideClipboard(): boolean {
  return readSlideClipboard() !== null
}
