/**
 * renderer/runText/textTransform.ts — CSS `text-transform` as a string
 * operation (ADR 0018): a canvas draws characters, so the transform the
 * browser applied at layout is applied to the string before it is drawn.
 */

const LETTER = /\p{L}/u
const WORD_INNER = /[\p{L}\p{N}'’]/u

/** `text` transformed; `before` is the character laid out just before it (capitalize). */
export function transformText(text: string, transform: string, before: string): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  if (transform !== 'capitalize') return text
  let out = ''
  let prev = before
  for (const ch of text) {
    out += LETTER.test(ch) && !WORD_INNER.test(prev) ? ch.toUpperCase() : ch
    prev = ch
  }
  return out
}
