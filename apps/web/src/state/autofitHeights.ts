/**
 * state/autofitHeights.ts — a person's growing text box keeps its `height`
 * current (agentic A4.2a, `autofit: 'grow-down'`).
 *
 * The renderer draws a growing box as tall as its laid-out text whatever
 * `height` says; only a browser can lay text out, so the height in the
 * document is written by the editor of the person who changed the box —
 * never because a deck was opened, an agent wrote to it, a peer edited it
 * or an undo restored it (decided 2026-10-12: drawing follows the text, the
 * stored height follows people).
 *
 * After every transaction of `LOCAL_ORIGIN` (typing, the Inspector, a width
 * drag — the person's own commands), each growing text box it changed is
 * measured at once and, if its height differs, the measured height is
 * written. At once — in a microtask of the same tick, not when the canvas
 * draws the next frame — so the write joins the person's change in the undo
 * capture window and lands before a gesture closes its step: one change,
 * one undo step. The write is itself a local change of the box, which then
 * measures equal and writes nothing. Any other origin (the undo manager,
 * the sync provider, an agent's run) is drawn but never written back.
 */

import * as Y from 'yjs'
import { LOCAL_ORIGIN, yMapToPlainObject } from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'

/** Below this the drawn and stored heights are the same (sub-pixel layout noise). */
export const HEIGHT_TOLERANCE_PX = 0.5

export interface AutofitHeightsOptions {
  /** The height the box would be drawn at now. */
  measure: (data: TextObject) => number
  /** Write `height` onto the object (a command, so it is the person's change). */
  write: (slideId: string, objectId: string, height: number) => void
}

/**
 * A text box's own keys that cannot change how tall its text lays out: where
 * the box sits, how it is composited, and what the editor alone reads. A
 * transaction that changed only these on a box (a drag, a nudge, a rotation,
 * an opacity slider) needs no measurement (performance.md → E4: a crowded
 * drag measured every grown box on every pointer move). Anything not listed
 * — the text, width, typography, padding, `height` itself — is measured, so
 * a key added later errs on the side of measuring.
 */
const NON_LAYOUT_KEYS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'rotation',
  'opacity',
  'name',
  'locked',
  'shadow',
  'blur',
  'groupId',
  'hyperlink',
  'aspectLocked',
])

function isTextBox(t: unknown): t is Y.Map<unknown> {
  return t instanceof Y.Map && t.get('type') === 'text' && typeof t.get('id') === 'string'
}

/**
 * The text-box maps a transaction changed in a way that can move their laid-out
 * height: each changed type's nearest enclosing text object, unless the type is
 * the box itself and only its non-layout keys changed.
 */
export function changedTextBoxes(transaction: Y.Transaction): Set<Y.Map<unknown>> {
  const maps = new Set<Y.Map<unknown>>()
  for (const [type, keys] of transaction.changed) {
    if (isTextBox(type)) {
      // `keys` holds the box's changed map keys (no null: a Y.Map has no content of its own).
      if ([...keys].every((k) => k !== null && NON_LAYOUT_KEYS.has(k))) continue
      maps.add(type)
      continue
    }
    // A nested type (the text's runs): its nearest enclosing text box.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types its event parameter as any
    let t: Y.AbstractType<Y.YEvent<any>> | null = type.parent
    while (t !== null) {
      if (isTextBox(t)) {
        maps.add(t)
        break
      }
      t = t.parent
    }
  }
  return maps
}

/** The id of the slide an object map lives on (object map → objects array → slide map). */
function slideIdOf(objectMap: Y.Map<unknown>): string | null {
  const slide = objectMap.parent?.parent
  if (!(slide instanceof Y.Map)) return null
  const id = slide.get('id')
  return typeof id === 'string' ? id : null
}

/** Start writing a person's grown boxes back; returns the stop function. */
export function watchAutofitHeights(doc: Y.Doc, options: AutofitHeightsOptions): () => void {
  let stopped = false
  const writeBack = (map: Y.Map<unknown>): void => {
    // Deleted meanwhile, or no longer growing.
    if (map.doc === null || map.get('autofit') !== 'grow-down') return
    const stored = map.get('height')
    const objectId = map.get('id')
    const slideId = slideIdOf(map)
    if (typeof stored !== 'number' || typeof objectId !== 'string' || slideId === null) return
    const drawn = options.measure(yMapToPlainObject<TextObject>(map))
    if (!Number.isFinite(drawn) || Math.abs(drawn - stored) <= HEIGHT_TOLERANCE_PX) return
    options.write(slideId, objectId, Math.round(drawn * 100) / 100)
  }
  const onTransaction = (transaction: Y.Transaction): void => {
    if (transaction.origin !== LOCAL_ORIGIN) return
    const maps = changedTextBoxes(transaction)
    if (maps.size === 0) return
    // After the transaction has finished (a write inside it would nest).
    queueMicrotask(() => {
      if (stopped) return
      for (const map of maps) writeBack(map)
    })
  }
  doc.on('afterTransaction', onTransaction)
  return () => {
    stopped = true
    doc.off('afterTransaction', onTransaction)
  }
}
