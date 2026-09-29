/**
 * commands/src/text/edit.ts — editing a text body in place, in the display
 * offsets queries report (a paragraph break "\n\n" counts 2), with the
 * editor's rules:
 *
 *   - inserted text takes the formatting of the text before it (typing
 *     inside a bold word stays bold);
 *   - "\n\n" in inserted text starts a new paragraph that continues the
 *     list of the paragraph it splits, as Enter does; a single "\n" is a
 *     line break inside the paragraph;
 *   - Enter on an empty list item outdents it, or ends the list at level 0;
 *   - Backspace at the start of an indented paragraph outdents it, at the
 *     start of the first paragraph's list item removes the list, and
 *     otherwise joins the paragraph to the previous one.
 *
 * Every function writes through slide-model writers and must run inside
 * the command's transaction.
 */

import type * as Y from 'yjs'
import {
  PARAGRAPH_SEP,
  applyFormat,
  applyParagraphPatch,
  clearFormat,
  getParagraphs,
  getPlainString,
  indentParagraphs,
  richAttrsAtIndex,
  spliceRichText,
  splitParagraphAt,
  type ParagraphPatch,
  type RichAttrs,
} from '@narrative/slide-model'
import { CommandError } from '../errors.js'
import { displayOf, displayRangeOf } from './body.js'
import { RUN_ATTR_KEYS } from './typography.js'

const CLEAR_LIST: ParagraphPatch = {
  list: null,
  level: null,
  bulletChar: null,
  numberFormat: null,
  startAt: null,
}

/** Whether display offset `at` falls between the two characters of a paragraph break. */
export function insideBreak(raw: string, at: number): boolean {
  const { toRaw } = displayOf(raw)
  return (
    at > 0 && at < toRaw.length && toRaw[at - 1] === toRaw[at] && raw[toRaw[at]!] === PARAGRAPH_SEP
  )
}

/** The display offset of a stored-body offset. */
export function displayOffsetOf(raw: string, rawIndex: number): number {
  return displayRangeOf(raw, rawIndex, rawIndex).start
}

/** The stored-body offset of a display offset; `conflict` past the end of the text. */
export function rawOffsetOf(raw: string, displayIndex: number): number {
  const d = displayOf(raw)
  if (displayIndex > d.display.length) {
    throw new CommandError(
      'conflict',
      `offset ${displayIndex} is past the end of the text (${d.display.length} characters)`,
    )
  }
  return d.toRaw[displayIndex]!
}

/**
 * Replace the display range [start, start + length) of `body` with
 * `insert`. Returns the stored offset right after the inserted text.
 */
export function spliceDisplay(
  doc: Y.Doc,
  body: Y.Text,
  start: number,
  length: number,
  insert: string,
  /**
   * Formatting the inserted text gets exactly (`text.replace`: that of the
   * text it replaces); omitted, it takes the formatting of the text before it.
   */
  format?: RichAttrs,
): number {
  const raw = getPlainString(body)
  const d = displayOf(raw)
  if (start + length > d.display.length) {
    throw new CommandError(
      'conflict',
      `range ${start}+${length} runs past the end of the text (${d.display.length} characters)`,
    )
  }
  if (insideBreak(raw, start) || insideBreak(raw, start + length)) {
    throw new CommandError(
      'conflict',
      'a range may not start or end inside a paragraph break ("\\n\\n" is removed or kept whole)',
    )
  }
  const from = d.toRaw[start]!
  const to = d.toRaw[start + length]!
  if (to > from) spliceRichText(doc, body, from, to - from, '')
  let pos = from
  insert.split('\n\n').forEach((piece, i) => {
    if (i > 0) pos = splitParagraphAt(body, pos)
    if (piece.length > 0) {
      spliceRichText(doc, body, pos, 0, piece)
      if (format !== undefined) {
        clearFormat(body, pos, piece.length, RUN_ATTR_KEYS)
        if (Object.keys(format).length > 0) applyFormat(body, pos, piece.length, format)
      }
      pos += piece.length
    }
  })
  return pos
}

/** The inline formatting of the character at stored offset `pos` (run attributes only). */
export function runFormatAt(body: Y.Text, pos: number): RichAttrs {
  const attrs = richAttrsAtIndex(body, pos + 1)
  const out: Record<string, unknown> = {}
  for (const key of RUN_ATTR_KEYS) if (attrs[key] !== undefined) out[key] = attrs[key]
  return out as RichAttrs
}

/** Enter at stored offset `pos`: the editor's rule. Returns where the caret goes. */
export function enterAt(body: Y.Text, pos: number): number {
  const paras = getParagraphs(body)
  const para = paras.find((p) => p.start <= pos && pos <= p.end) ?? paras[paras.length - 1]!
  if (para.text.length === 0 && para.attrs.list !== undefined) {
    // Empty list item: outdent one level, or leave the list at level 0
    // (Keynote / PowerPoint behaviour).
    if ((para.attrs.level ?? 0) > 0) indentParagraphs(body, pos, pos, -1)
    else applyParagraphPatch(body, pos, pos, CLEAR_LIST)
    return pos
  }
  return splitParagraphAt(body, pos)
}

/** Backspace with a collapsed caret at stored offset `pos`: the editor's rule. Returns where the caret goes. */
export function backspaceAt(doc: Y.Doc, body: Y.Text, pos: number): number {
  const paras = getParagraphs(body)
  const idx = paras.findIndex((p) => p.start <= pos && pos <= p.end)
  if (idx < 0) return pos
  const para = paras[idx]!
  // The very start of a plain, unindented first paragraph: nothing to do.
  if (pos === 0 && para.attrs.list === undefined && (para.attrs.level ?? 0) === 0) return pos
  if (pos !== para.start) {
    // Inside a paragraph: delete the character before the caret (both
    // halves of a surrogate pair).
    const raw = getPlainString(body)
    const pair =
      pos >= 2 && /[\uDC00-\uDFFF]/.test(raw[pos - 1]!) && /[\uD800-\uDBFF]/.test(raw[pos - 2]!)
    const n = pair ? 2 : 1
    spliceRichText(doc, body, pos - n, n, '')
    return pos - n
  }
  if ((para.attrs.level ?? 0) > 0) {
    indentParagraphs(body, pos, pos, -1)
    return pos
  }
  if (idx === 0) {
    applyParagraphPatch(body, pos, pos, CLEAR_LIST)
    return pos
  }
  // Join to the previous paragraph: remove the separator between them.
  if (getPlainString(body)[pos - 1] === PARAGRAPH_SEP) spliceRichText(doc, body, pos - 1, 1, '')
  return pos - 1
}
