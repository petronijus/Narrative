/**
 * state/slideClipboard.ts
 *
 * P11 (round 3): Cross-deck clipboard for whole slides.
 *
 * Parallel to state/clipboard.ts (object-level). Copying a slide row
 * captures a JSON-safe snapshot of the slide(s) — id, objects, animations,
 * transition, background, name — and writes it to localStorage so paste
 * can land in another deck or another tab.
 *
 * On paste, slideHelpers.pasteSlides creates fresh slides via addSlide
 * and copies the captured objects + animations. Source object IDs are
 * preserved (Magic Move parity, animation objectId references stay
 * valid; ids are slide-local so collisions across decks are fine).
 */

import type { Slide } from '@narrative/shared'

const LS_KEY = 'narrative:slideClipboard'

let clipboard: Slide[] | null = null

function writeLS(slides: Slide[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(slides))
  } catch {
    /* quota or unavailable */
  }
}

function readLS(): Slide[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return null
      const rec = item as Record<string, unknown>
      if (typeof rec.id !== 'string') return null
      if (!Array.isArray(rec.objects)) return null
      if (!Array.isArray(rec.animations)) return null
    }
    return parsed as Slide[]
  } catch {
    return null
  }
}

function clearLS(): void {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}

export function setSlideClipboard(slides: ReadonlyArray<Slide>): void {
  if (slides.length === 0) {
    clipboard = null
    clearLS()
    return
  }
  clipboard = slides.map((s) => structuredClone(s))
  writeLS(clipboard)
}

export function hasSlideClipboard(): boolean {
  if (clipboard !== null && clipboard.length > 0) return true
  const ls = readLS()
  if (ls !== null) {
    clipboard = ls
    return true
  }
  return false
}

/**
 * Returns a fresh array of plain Slide snapshots ready for paste.
 * Caller is responsible for stamping them into the target deck via
 * slideHelpers.pasteSlides.
 */
export function readSlideClipboard(): Slide[] | null {
  if (clipboard !== null && clipboard.length > 0) {
    return clipboard.map((s) => structuredClone(s))
  }
  const ls = readLS()
  if (ls === null) return null
  clipboard = ls
  return ls.map((s) => structuredClone(s))
}
