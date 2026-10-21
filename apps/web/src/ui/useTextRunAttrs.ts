/**
 * ui/useTextRunAttrs.ts — what the Typography section shows of a text
 * box's body: the inline format under the caret (Bold / Italic /
 * Underline, size, colour) and the list state of the targeted paragraphs.
 *
 * Both are read from the box's Y.Text and the active text-edit selection,
 * neither of which is a field of the object's snapshot: typing changes the
 * Y.Text without changing any field the Inspector compares, and every
 * keystroke moves the caret. The section used to re-render on both, once
 * per key, to recompute these two values that almost never change while
 * typing (performance.md → E6). This hook recomputes them when the
 * document or the selection changed and re-renders its reader only when
 * the result differs by value — the Inspector's other sections, which show
 * no part of the body, compare the Y.Text by identity
 * (`sameObjectFields`, state/useDeckStore.ts) and skip typing altogether.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { ParagraphAttrs, Slide, TextObject } from '@narrative/shared'
import type { RichAttrs } from '@narrative/slide-model'
import { useDeckStore } from '../state/useDeckStore.js'
import {
  getActiveTextSelection,
  readActiveSelectionAttrs,
  subscribeActiveTextSelection,
  type ActiveTextSelection,
} from './textEditSelection.js'
import { currentParagraphAttrs } from './textListOps.js'

export interface TextRunAttrs {
  /** The inline format of the selected run; null without a range selection in this box. */
  selAttrs: RichAttrs | null
  /** The list state of the paragraphs the selection covers (all of them without one). */
  paraAttrs: ParagraphAttrs
}

/** Flat attribute records: same keys, same values (the values are primitives). */
function sameAttrs(
  a: Readonly<Record<string, unknown>> | null,
  b: Readonly<Record<string, unknown>> | null,
): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false
  }
  return true
}

export function sameTextRunAttrs(a: TextRunAttrs, b: TextRunAttrs): boolean {
  return (
    sameAttrs(
      a.selAttrs as Record<string, unknown> | null,
      b.selAttrs as Record<string, unknown> | null,
    ) &&
    sameAttrs(
      a.paraAttrs as unknown as Record<string, unknown>,
      b.paraAttrs as unknown as Record<string, unknown>,
    )
  )
}

/** The values for `obj` now: exactly what the section computed on each render before. */
export function readTextRunAttrs(obj: TextObject): TextRunAttrs {
  const sel = getActiveTextSelection()
  return {
    selAttrs: sel !== null && sel.objectId === obj.id ? readActiveSelectionAttrs(obj.id) : null,
    paraAttrs: currentParagraphAttrs(obj),
  }
}

/**
 * The body's run and paragraph state for `obj`, current with the document
 * and the selection; a new value only when it differs.
 */
export function useTextRunAttrs(obj: TextObject): TextRunAttrs {
  const store = useDeckStore()
  const memo = useRef<{
    version: Slide[]
    sel: ActiveTextSelection | null
    obj: TextObject
    value: TextRunAttrs
  } | null>(null)
  const subscribe = useCallback(
    (listener: () => void) => {
      const offDeck = store.subscribe(listener)
      const offSel = subscribeActiveTextSelection(listener)
      return () => {
        offDeck()
        offSel()
      }
    },
    [store],
  )
  const getSnapshot = (): TextRunAttrs => {
    // A change inside the Y.Text gives a new slide list (the store's
    // version); a moved caret a new selection; another box a new `obj`.
    const version = store.getSlides()
    const sel = getActiveTextSelection()
    const prev = memo.current
    if (prev !== null && prev.version === version && prev.sel === sel && prev.obj === obj)
      return prev.value
    const next = readTextRunAttrs(obj)
    const value = prev !== null && sameTextRunAttrs(prev.value, next) ? prev.value : next
    memo.current = { version, sel, obj, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
