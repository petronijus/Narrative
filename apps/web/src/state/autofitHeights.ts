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

/** The text-box maps a transaction changed: each changed type's nearest enclosing text object. */
function changedTextBoxes(transaction: Y.Transaction): Set<Y.Map<unknown>> {
  const maps = new Set<Y.Map<unknown>>()
  for (const type of transaction.changed.keys()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types its event parameter as any
    let t: Y.AbstractType<Y.YEvent<any>> | null = type
    while (t !== null) {
      if (t instanceof Y.Map && t.get('type') === 'text' && typeof t.get('id') === 'string') {
        maps.add(t as Y.Map<unknown>)
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
