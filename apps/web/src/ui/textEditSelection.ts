/**
 * ui/textEditSelection.ts
 *
 * Tiny module-level singleton tracking the *currently active* inline
 * text-edit selection. TextEditOverlay updates this on every focus /
 * select / input event; the Inspector's style toggles read it so a
 * Bold/Italic/Underline click formats just the selected range via
 * Y.Text.format() instead of patching the box-wide field.
 *
 * Stored as a window-level slot rather than React context because the
 * Inspector and the overlay live on far-apart branches of the tree
 * and a context provider would have to wrap the whole editor shell
 * just to communicate a transient four-field structure.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN, applyFormat, clearFormat, type RichAttrs } from '@narrative/slide-model'

export interface ActiveTextSelection {
  objectId: string
  yText: Y.Text
  /** UTF-16 code-unit indices into the Y.Text content. */
  start: number
  end: number
  /**
   * Re-focus the underlying textarea and restore the selection range
   * captured in `start`/`end`. Called by Inspector controls (font
   * weight / family selects) after mutation to undo the focus loss
   * that opening the native `<select>` causes.
   */
  refocus: () => void
}

const slot: { current: ActiveTextSelection | null } = { current: null }
const listeners = new Set<() => void>()

export function setActiveTextSelection(sel: ActiveTextSelection | null): void {
  // Skip notify when nothing meaningful changed — TextEditOverlay
  // re-publishes on every keystroke, but the toggle buttons only
  // need to refresh when objectId / range changes (typing inside a
  // formatted run keeps the same start/end).
  const cur = slot.current
  if (cur === null && sel === null) return
  if (
    cur !== null &&
    sel !== null &&
    cur.objectId === sel.objectId &&
    cur.yText === sel.yText &&
    cur.start === sel.start &&
    cur.end === sel.end &&
    cur.refocus === sel.refocus
  ) {
    return
  }
  slot.current = sel
  for (const l of listeners) l()
}

export function getActiveTextSelection(): ActiveTextSelection | null {
  return slot.current
}

/** useSyncExternalStore-compatible subscriber. */
export function subscribeActiveTextSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Run one user formatting action as ONE `LOCAL_ORIGIN` transaction.
 *
 * A formatting gesture in the Inspector is usually two writes: strip the
 * inline run overrides for a key (`Y.Text.format`) and patch the box-wide
 * field (`updateObject`). Run bare, the `format` call opens its own
 * transaction with no origin — the editor's `Y.UndoManager` tracks only
 * `LOCAL_ORIGIN`, so the strip silently falls out of undo history while
 * the patch lands on it, and Mod+Z restores the box value but not the
 * runs. Wrapping the whole gesture makes it exactly one undo step and one
 * Yjs update (nested `doc.transact` calls keep the outermost origin).
 *
 * The doc comes from the object's own Y.Text, or — for objects whose
 * `text` is not a live Y.Text, e.g. a table cell edit — from the active
 * selection when it belongs to `objectId`. With neither there is no inline
 * run to touch, every write in `fn` is a slide-model mutation that already
 * carries `LOCAL_ORIGIN`, and `fn` runs as is.
 */
export function transactTextAction(target: { id: string; text?: unknown }, fn: () => void): void {
  const doc = docForTextAction(target)
  if (doc === null) {
    fn()
    return
  }
  doc.transact(fn, LOCAL_ORIGIN)
}

function docForTextAction(target: { id: string; text?: unknown }): Y.Doc | null {
  if (target.text instanceof Y.Text && target.text.doc !== null) return target.text.doc
  const sel = slot.current
  if (sel !== null && sel.objectId === target.id) return sel.yText.doc
  return null
}

/** Run `fn` in a `LOCAL_ORIGIN` transaction on `yText`'s doc (or bare when detached). */
function transactOn(yText: Y.Text, fn: () => void): void {
  const doc = yText.doc
  if (doc === null) fn()
  else doc.transact(fn, LOCAL_ORIGIN)
}

/**
 * Returns `true` when the active selection covers the entire Y.Text
 * content for the given object (effectively a Cmd+A). Inspector
 * controls use this to decide whether to patch the box-wide field
 * (so the picker UI reflects the change) instead of treating the
 * change as an inline-only run override.
 */
export function isEntireContentSelected(objectId: string): boolean {
  const sel = slot.current
  if (sel === null || sel.objectId !== objectId) return false
  if (sel.end <= sel.start) return false
  return sel.start === 0 && sel.end === sel.yText.length
}

/**
 * Strip the named keys from EVERY run of the given Y.Text. Inspector
 * controls call this when the text object is selected without an
 * active edit overlay and the user changes a typography field — any
 * inline overrides set earlier on individual runs would otherwise
 * shadow the new box-wide value, leaving stray formatting after a
 * "select the text box and change everything to Inter" gesture.
 */
export function clearAllInlineRunAttrs(text: unknown, keys: ReadonlyArray<keyof RichAttrs>): void {
  if (!(text instanceof Y.Text)) return
  if (text.length <= 0) return
  transactOn(text, () => clearFormat(text, 0, text.length, keys))
}

/**
 * Strip the named keys from the active selection range — used after
 * a whole-content "Cmd+A → change font" so any inline overrides set
 * earlier on individual runs don't shadow the new box-wide value.
 */
export function clearActiveSelectionAttrs(
  objectId: string,
  keys: ReadonlyArray<keyof RichAttrs>,
): void {
  const sel = slot.current
  if (sel === null || sel.objectId !== objectId) return
  const length = sel.end - sel.start
  if (length <= 0) return
  transactOn(sel.yText, () => clearFormat(sel.yText, sel.start, length, keys))
}

/**
 * Re-focus the active text-edit textarea (and restore its selection
 * range) for the given object. Inspector controls call this after
 * a `<select>` change so the textarea regains focus and the user
 * can keep typing without an extra click.
 */
export function refocusActiveTextEdit(objectId: string): void {
  const sel = slot.current
  if (sel === null || sel.objectId !== objectId) return
  sel.refocus()
}

/**
 * Apply an inline format to the active text selection, if any.
 * Returns `true` when the format was applied to a non-empty range
 * (caller should NOT patch the box-wide field). Returns `false`
 * when there is no overlay open, no selection, or the selection
 * is collapsed (caller falls back to patching the whole object).
 *
 * `objectId` guard — only honour the format when the inspector's
 * current target matches the overlay's; otherwise an inspector for
 * a different object would unexpectedly mutate whichever text is
 * being edited.
 */
export function applyInlineFormatIfSelected(objectId: string, attrs: RichAttrs): boolean {
  const sel = slot.current
  if (sel === null) return false
  if (sel.objectId !== objectId) return false
  const length = sel.end - sel.start
  if (length <= 0) return false
  transactOn(sel.yText, () => applyFormat(sel.yText, sel.start, length, attrs))
  return true
}

/**
 * Read the format attributes at the start of the active selection so a
 * toggle button can decide whether to add or remove a format. Returns
 * `null` when there is no selection (caller should toggle the
 * box-wide field instead). Returns `{}` when the selection sits in an
 * unformatted run.
 */
export function readActiveSelectionAttrs(objectId: string): RichAttrs | null {
  const sel = slot.current
  if (sel === null || sel.objectId !== objectId) return null
  if (sel.end <= sel.start) return null
  const raw = sel.yText.toDelta() as Array<{
    insert: unknown
    attributes?: Record<string, unknown>
  }>
  let pos = 0
  for (const op of raw) {
    const insert = typeof op.insert === 'string' ? op.insert : ''
    const next = pos + insert.length
    if (sel.start < next) {
      const src = op.attributes ?? {}
      const a: RichAttrs = {}
      if (src['italic'] === true) a.italic = true
      else if (src['italic'] === false) a.italic = false
      if (src['underline'] === true) a.underline = true
      else if (src['underline'] === false) a.underline = false
      if (typeof src['fontWeight'] === 'number') a.fontWeight = src['fontWeight']
      if (typeof src['color'] === 'number') a.color = src['color']
      return a
    }
    pos = next
  }
  return {}
}
