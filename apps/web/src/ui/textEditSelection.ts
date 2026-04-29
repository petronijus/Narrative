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

import type * as Y from 'yjs'
import { applyFormat, type RichAttrs } from '@narrative/slide-model'

export interface ActiveTextSelection {
  objectId: string
  yText: Y.Text
  /** UTF-16 code-unit indices into the Y.Text content. */
  start: number
  end: number
}

const slot: { current: ActiveTextSelection | null } = { current: null }

export function setActiveTextSelection(sel: ActiveTextSelection | null): void {
  slot.current = sel
}

export function getActiveTextSelection(): ActiveTextSelection | null {
  return slot.current
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
  applyFormat(sel.yText, sel.start, length, attrs)
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
