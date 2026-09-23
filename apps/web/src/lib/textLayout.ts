/**
 * lib/textLayout.ts
 *
 * How a TextObject's paragraphs are laid out — shared by the Pixi renderer
 * and the contenteditable edit overlay, so edit mode and render mode draw
 * the same markers, indents, paragraph spacing and line boxes. Kept out of
 * the renderer so the overlay never imports Pixi-side state.
 *
 * Line height follows the fonts on the line (see `resolveLineHeightPx`):
 * each paragraph is laid out at the line height of its own largest font.
 */

import * as Y from 'yjs'
import {
  getParagraphDeltas,
  paragraphFontSizePx,
  PARAGRAPH_SEP,
  type ListedHtmlOptions,
  type ParagraphDelta,
} from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { resolveLineHeightPx } from './fontLineMetrics.js'

/** A text body as paragraphs: a Y.Text's, or a legacy string split on U+2029. */
export function paragraphsOf(obj: Pick<TextObject, 'text'>): ParagraphDelta[] {
  const t = obj.text
  if (t instanceof Y.Text) return getParagraphDeltas(t)
  return (typeof t === 'string' ? t : '')
    .split(PARAGRAPH_SEP)
    .map((seg) => ({ ops: seg.length > 0 ? [{ insert: seg }] : [], attrs: {} }))
}

/** The shared `ListedHtmlOptions` for a TextObject. */
export function listedHtmlOptionsFor(obj: TextObject): ListedHtmlOptions {
  const o: ListedHtmlOptions = {}
  if (obj.italic === true) o.italic = true
  if (obj.underline === true) o.underline = true
  if (typeof obj.paragraphSpaceBefore === 'number' && obj.paragraphSpaceBefore > 0) {
    o.paragraphSpaceBefore = obj.paragraphSpaceBefore
  }
  if (typeof obj.paragraphSpaceAfter === 'number' && obj.paragraphSpaceAfter > 0) {
    o.paragraphSpaceAfter = obj.paragraphSpaceAfter
  }
  if (obj.listStyle !== undefined) o.legacyListStyle = obj.listStyle
  if (obj.fontSize > 0) {
    o.fontSize = obj.fontSize
    o.lineHeightForFontSize = (size) => resolveLineHeightPx(obj, size)
  }
  return o
}

/** The largest font on the first line — the one the block's placement follows. */
export function firstLineFontSizePx(obj: TextObject): number {
  const first = paragraphsOf(obj)[0]
  return first !== undefined ? paragraphFontSizePx(first, obj.fontSize) : obj.fontSize
}

/** The largest font the text is set in (text with no size of its own is the frame's). */
export function largestFontSizePx(obj: TextObject): number {
  let size = 0
  for (const p of paragraphsOf(obj)) size = Math.max(size, paragraphFontSizePx(p, obj.fontSize))
  return size > 0 ? size : obj.fontSize
}
