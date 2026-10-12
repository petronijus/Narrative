/**
 * ui/textListOps.ts
 *
 * Bridge between the Inspector's list controls and `text.list`. Resolves
 * which part of the body a list operation targets:
 *
 *  - While an edit overlay is open for this object, the active selection
 *    (or caret) decides the affected paragraphs — a collapsed caret
 *    targets just its paragraph, a selection targets every paragraph it
 *    spans.
 *  - Otherwise (text box selected on canvas, not editing) the whole body
 *    is targeted.
 *
 * `text.list` carries the rules: a glyph implies a bullet list, a number
 * format a numbered one, "no list" clears the decorations too, and a
 * legacy frame-wide `listStyle` becomes per-paragraph attributes on the
 * first list edit. Reading the paragraph state for the controls stays here
 * (`currentParagraphAttrs`).
 */

import * as Y from 'yjs'
import { displayRangeOf } from '@narrative/commands'
import { getPlainString, readParagraphAttrsForRange } from '@narrative/slide-model'
import type { ListKind, ListNumberFormat, ParagraphAttrs, TextObject } from '@narrative/shared'
import type { CommandDispatch } from '../state/useCommand.js'
import { getActiveTextSelection } from './textEditSelection.js'

/** Where a list operation is dispatched: the slide the box is on and the editor's command dispatch. */
export interface ListTarget {
  slide: string
  command: CommandDispatch
}

/** The selected (or caret) range of `obj`'s body while it is being edited, in display offsets. */
function editedRange(obj: TextObject): { start: number; length: number } | undefined {
  const sel = getActiveTextSelection()
  if (sel === null || sel.objectId !== obj.id || !(obj.text instanceof Y.Text)) return undefined
  if (sel.yText !== obj.text) return undefined
  return displayRangeOf(getPlainString(sel.yText), sel.start, sel.end)
}

function runList(obj: TextObject, t: ListTarget, settings: Record<string, unknown>): void {
  const range = editedRange(obj)
  t.command.tryRun('text.list', {
    target: { slide: t.slide, object: obj.id },
    ...(range === undefined ? {} : { range }),
    ...settings,
  })
}

/** Current shared paragraph attributes for the inspector's control state. */
export function currentParagraphAttrs(obj: TextObject): ParagraphAttrs {
  if (!(obj.text instanceof Y.Text)) {
    return obj.listStyle !== undefined
      ? { list: obj.listStyle === 'numbered' ? 'number' : 'bullet' }
      : {}
  }
  const sel = getActiveTextSelection()
  if (sel !== null && sel.objectId === obj.id && sel.yText === obj.text) {
    return readParagraphAttrsForRange(obj.text, sel.start, sel.end, obj.listLevels)
  }
  return readParagraphAttrsForRange(obj.text, 0, obj.text.length, obj.listLevels)
}

/** Set the list kind on the targeted paragraphs, or remove the list (`null`). */
export function setListKind(obj: TextObject, kind: ListKind | null, t: ListTarget): void {
  runList(obj, t, { kind: kind ?? 'none' })
}

/** Set a custom bullet glyph (or clear back to the per-level default). */
export function setBulletChar(obj: TextObject, glyph: string | null, t: ListTarget): void {
  runList(obj, t, { bulletChar: glyph })
}

/** Set the numbering scheme for numbered paragraphs. */
export function setNumberFormat(obj: TextObject, fmt: ListNumberFormat, t: ListTarget): void {
  runList(obj, t, { numberFormat: fmt })
}

/** Restart numbering at `n` (or clear the restart with `null`). */
export function setStartAt(obj: TextObject, n: number | null, t: ListTarget): void {
  runList(obj, t, { startAt: n !== null && n >= 1 ? n : null })
}

/** Indent (+1) or outdent (−1) the targeted paragraphs. */
export function indentList(obj: TextObject, delta: number, t: ListTarget): void {
  runList(obj, t, { indent: delta })
}
