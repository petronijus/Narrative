/**
 * components/presentStartSlide.ts
 *
 * `/deck/:id/present?slide=N` — where present mode starts (agentic A1: the
 * server's `editor.present.link` hands out exactly this URL).
 *
 * N is the 1-based position of the slide in the deck, counting EVERY slide
 * in document order — skipped slides included. That is what the server
 * computes (`resolveSlide(...).index + 1`) and the number the slides panel
 * shows, so a link means the same slide to the agent, the person and this
 * function.
 *
 * - N above the slide count is clamped to the last slide (a link that
 *   outlived deleted slides still opens the deck, at its end).
 * - N below 1, or anything that is not a plain positive integer, is ignored:
 *   present mode starts where it would without the parameter (the active
 *   slide).
 * - A skipped slide is honoured when named explicitly, exactly as present
 *   mode already starts on a skipped active slide; navigating on from it
 *   skips skipped slides as usual.
 */

/** The id of the slide `?slide=` names, or null when absent / invalid / the deck is empty. */
export function presentStartSlideId(
  param: string | null,
  slides: ReadonlyArray<{ id: string }>,
): string | null {
  if (param === null || slides.length === 0) return null
  const trimmed = param.trim()
  if (!/^\d+$/.test(trimmed)) return null
  // Digits only, so `n` is a non-negative integer — or Infinity/imprecise for
  // absurdly long input, which the clamp below handles like any large N.
  const n = Number(trimmed)
  if (n < 1) return null
  return slides[Math.min(n, slides.length) - 1]?.id ?? null
}
