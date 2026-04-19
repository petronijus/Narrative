/**
 * slide-model/src/yDoc.ts
 *
 * Y.Doc factory pro jeden slide.
 *
 * Architektonická volba (ADR-0003):
 * Místo Y.Array uvnitř Y.Map používáme doc.getArray('objects') přímo na root doc.
 * Důvod: Y.Array uvnitř Y.Map má na Windows/jsdom observer gotchy s timing
 * a Y.UndoManager trackingem. Root-level getArray() je robustnější.
 * Slide metadata (id) jsou v separátním doc.getMap('slideMeta').
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'

export interface SlideDocHandles {
  doc: Y.Doc
  /** Y.Map pro metadata slidu (id, budoucí: background, theme...) */
  slideMeta: Y.Map<unknown>
  /** Y.Array objektů na slidu — root-level na doc pro stabilní observer tracking */
  objects: Y.Array<Y.Map<unknown>>
}

/**
 * Vytvoří nový Y.Doc s prázdným slidem.
 * objects je root-level Y.Array — stabilnější pro UndoManager a observe.
 */
export function createSlideDoc(): SlideDocHandles {
  const doc = new Y.Doc()

  // Root-level Y.Map pro metadata slidu
  const slideMeta = doc.getMap<unknown>('slideMeta')

  // Root-level Y.Array pro objekty — viz architektonická volba výše
  const objects = doc.getArray<Y.Map<unknown>>('objects')

  // Inicializace metadat v transakci
  doc.transact(() => {
    slideMeta.set('id', nanoid())
  })

  return { doc, slideMeta, objects }
}
