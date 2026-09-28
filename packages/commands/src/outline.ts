/**
 * commands/src/outline.ts — the rules of the slide outline.
 *
 * Every slide has an outline level (`indent`, 0 = top). A slide belongs to
 * the nearest slide above it with a smaller level, so the outline is only
 * well formed when:
 *
 *   - the first slide is at level 0;
 *   - no slide is more than one level deeper than the slide above it;
 *   - no level exceeds MAX_SLIDE_INDENT.
 *
 * These are the rules the slides panel enforces while dragging. They live
 * here so every command that changes the slide order (move, delete, copy,
 * indent) leaves a well-formed outline whoever called it, and so the panel's
 * drag preview uses the same arithmetic as the command it dispatches.
 */

import type { DeckMutationContext } from '@narrative/slide-model'
import { setSlideIndent } from '@narrative/slide-model'

/** Deepest outline level the slides panel supports. */
export const MAX_SLIDE_INDENT = 6

/** The stored level of a slide map (absent = 0). */
export function levelOf(slide: { get(key: string): unknown }): number {
  const raw = slide.get('indent')
  return typeof raw === 'number' && raw > 0 ? Math.floor(raw) : 0
}

/** Deepest level a slide may take when `above` is the level of the slide right above it (none = first slide). */
export function maxLevelBelow(above: number | undefined): number {
  return above === undefined ? 0 : Math.min(MAX_SLIDE_INDENT, above + 1)
}

/**
 * Levels for a block of slides placed right below a slide at `above`, with
 * the block's first slide asked to be at `first`: every slide of the block
 * shifts by the same amount (their relative levels stay), clamped to
 * 0..MAX_SLIDE_INDENT, and each is held to at most one level deeper than
 * the slide above it.
 */
export function shiftBlockLevels(
  levels: readonly number[],
  first: number,
  above: number | undefined,
): number[] {
  const [head] = levels
  if (head === undefined) return []
  const delta = Math.min(first, maxLevelBelow(above)) - head
  const out: number[] = []
  let prev = above
  for (const level of levels) {
    const shifted = Math.max(0, Math.min(MAX_SLIDE_INDENT, level + delta))
    const next = Math.min(shifted, maxLevelBelow(prev))
    out.push(next)
    prev = next
  }
  return out
}

/**
 * Bring the deck's outline back to well formed: every slide that is deeper
 * than the rules allow is raised to the deepest level it may take. Slides
 * that are fine are not touched, so a well-formed outline writes nothing.
 * Returns the ids of the slides whose level changed.
 */
export function normalizeOutline(deck: DeckMutationContext): string[] {
  const changed: string[] = []
  let above: number | undefined
  for (let i = 0; i < deck.slides.length; i++) {
    const slide = deck.slides.get(i)
    const level = levelOf(slide)
    const allowed = Math.min(level, maxLevelBelow(above))
    if (allowed !== level) {
      const id = slide.get('id') as string
      setSlideIndent(deck, id, allowed)
      changed.push(id)
    }
    above = allowed
  }
  return changed
}
