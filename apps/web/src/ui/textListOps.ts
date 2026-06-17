/**
 * ui/textListOps.ts
 *
 * Bridge between the Inspector's list controls and the per-paragraph list
 * model in `@narrative/slide-model`. Resolves which Y.Text + character
 * range a list operation should target:
 *
 *  - While an edit overlay is open for this object, the active selection
 *    (or caret) decides the affected paragraphs — a collapsed caret
 *    targets just its paragraph, a selection targets every paragraph it
 *    spans.
 *  - Otherwise (text box selected on canvas, not editing) the whole body
 *    is targeted.
 *
 * Legacy frame-wide `obj.listStyle` is migrated to per-paragraph block
 * attributes on the first list edit (and the field cleared via `patch`).
 * Legacy plain-string bodies (decks predating the Y.Text era) fall back to
 * patching `obj.listStyle` so they keep working until promoted.
 */

import * as Y from 'yjs'
import {
  applyParagraphPatch,
  indentParagraphs,
  readParagraphAttrsForRange,
  type ParagraphPatch,
} from '@narrative/slide-model'
import type {
  ListKind,
  ListNumberFormat,
  ParagraphAttrs,
  SlideObjectPatch,
  TextObject,
} from '@narrative/shared'
import { getActiveTextSelection } from './textEditSelection.js'

type PatchFn = (p: SlideObjectPatch<TextObject>) => void

interface Target {
  yText: Y.Text
  from: number
  to: number
}

function resolveTarget(obj: TextObject): Target | null {
  if (!(obj.text instanceof Y.Text)) return null
  const sel = getActiveTextSelection()
  if (sel !== null && sel.objectId === obj.id && sel.yText === obj.text) {
    return { yText: obj.text, from: sel.start, to: sel.end }
  }
  return { yText: obj.text, from: 0, to: obj.text.length }
}

function transact(yText: Y.Text, fn: () => void): void {
  const doc = yText.doc
  if (doc !== null) doc.transact(fn)
  else fn()
}

/** Migrate a legacy frame-wide `listStyle` into per-paragraph attrs once. */
function migrateLegacy(obj: TextObject, patch: PatchFn): void {
  if (!(obj.text instanceof Y.Text)) return
  if (obj.listStyle === undefined) return
  const kind: ListKind = obj.listStyle === 'numbered' ? 'number' : 'bullet'
  const yt = obj.text
  transact(yt, () => applyParagraphPatch(yt, 0, yt.length, { list: kind }))
  patch({ listStyle: undefined } as unknown as SlideObjectPatch<TextObject>)
}

/** Current shared paragraph attributes for the inspector's control state. */
export function currentParagraphAttrs(obj: TextObject): ParagraphAttrs {
  if (!(obj.text instanceof Y.Text)) {
    return obj.listStyle !== undefined
      ? { list: obj.listStyle === 'numbered' ? 'number' : 'bullet' }
      : {}
  }
  const t = resolveTarget(obj)
  if (t === null) return {}
  return readParagraphAttrsForRange(t.yText, t.from, t.to)
}

function applyPatch(obj: TextObject, patch: PatchFn, p: ParagraphPatch): void {
  if (!(obj.text instanceof Y.Text)) return
  migrateLegacy(obj, patch)
  const t = resolveTarget(obj)
  if (t === null) return
  transact(t.yText, () => applyParagraphPatch(t.yText, t.from, t.to, p))
}

/** Set (or clear, with `null`) the list kind on the targeted paragraphs. */
export function setListKind(obj: TextObject, kind: ListKind | null, patch: PatchFn): void {
  if (!(obj.text instanceof Y.Text)) {
    // Legacy plain string — keep the old frame-wide behavior.
    patch({
      listStyle: kind === null ? undefined : kind === 'number' ? 'numbered' : 'bullet',
    } as unknown as SlideObjectPatch<TextObject>)
    return
  }
  if (kind === null) {
    applyPatch(obj, patch, {
      list: null,
      level: null,
      bulletChar: null,
      numberFormat: null,
      startAt: null,
    })
    return
  }
  applyPatch(obj, patch, { list: kind })
}

/** Set a custom bullet glyph (or clear back to the per-level default). */
export function setBulletChar(obj: TextObject, glyph: string | null, patch: PatchFn): void {
  applyPatch(obj, patch, { list: 'bullet', bulletChar: glyph })
}

/** Set the numbering scheme for numbered paragraphs. */
export function setNumberFormat(obj: TextObject, fmt: ListNumberFormat, patch: PatchFn): void {
  applyPatch(obj, patch, { list: 'number', numberFormat: fmt })
}

/** Restart numbering at `n` (or clear the restart with `null`). */
export function setStartAt(obj: TextObject, n: number | null, patch: PatchFn): void {
  applyPatch(obj, patch, { startAt: n !== null && n >= 1 ? n : null })
}

/** Indent (+1) or outdent (−1) the targeted paragraphs. */
export function indentList(obj: TextObject, delta: number, patch: PatchFn): void {
  if (!(obj.text instanceof Y.Text)) return
  migrateLegacy(obj, patch)
  const t = resolveTarget(obj)
  if (t === null) return
  transact(t.yText, () => indentParagraphs(t.yText, t.from, t.to, delta))
}
